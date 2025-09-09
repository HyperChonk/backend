import * as Sentry from '@sentry/node';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, Message } from '@aws-sdk/client-sqs';
import { env } from '../env';
import { configureWorkerRoutes } from './job-handlers';
import express from 'express';
import http from 'http';

interface JobMessage {
    name: string;
    chain: string;
}

export class SQSWorkerService {
    private sqsClient: SQSClient;
    private isPolling = false;
    private app: express.Application;
    private healthServer: http.Server | null = null;
    private lastHealthyTime = Date.now();
    // Concurrency control for job processing to avoid DB connection exhaustion
    private maxConcurrentJobs: number = Number(process.env.WORKER_MAX_CONCURRENCY || 2);
    private currentJobs = 0;
    private waitQueue: Array<() => void> = [];

    // Queue URLs from environment
    private queueUrls: string[];

    constructor() {
        // Configure SQS client for LocalStack or AWS
        const sqsConfig: any = {
            region: env.AWS_REGION || 'us-east-1',
        };

        // For local development with LocalStack
        if (process.env.AWS_ENDPOINT_URL) {
            sqsConfig.endpoint = process.env.AWS_ENDPOINT_URL;
            sqsConfig.credentials = {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
            };
        }

        this.sqsClient = new SQSClient(sqsConfig);

        // Collect queue URLs from environment
        this.queueUrls = [
            process.env.SQS_BACKGROUND_JOB_QUEUE_URL,
            process.env.SQS_DATA_REFRESH_QUEUE_URL,
            process.env.SQS_NOTIFICATION_QUEUE_URL,
        ].filter(Boolean) as string[];

        // Create Express app for job processing (no HTTP server)
        this.app = express();
        this.app.use(express.json());
    }

    async start(): Promise<void> {
        console.log('🚀 Starting SQS Worker Service...');
        console.log(`📡 Monitoring ${this.queueUrls.length} queues:`);
        this.queueUrls.forEach((url) => console.log(`   - ${url}`));

        if (this.queueUrls.length === 0) {
            console.warn('⚠️  No SQS queue URLs configured. Worker will not process jobs.');
            return;
        }

        // Start health server first
        await this.startHealthServer();

        // Ensure queues exist (create them in LocalStack)
        await this.ensureQueuesExist();

        this.isPolling = true;

        // Start polling each queue concurrently
        const pollingPromises = this.queueUrls.map((queueUrl) => this.pollQueue(queueUrl));

        console.log('✅ SQS Worker Service started successfully');

        // Wait for all polling operations (they run indefinitely)
        await Promise.all(pollingPromises);
    }

    async stop(): Promise<void> {
        console.log('🛑 Stopping SQS Worker Service...');
        this.isPolling = false;

        if (this.healthServer) {
            this.healthServer.close();
            console.log('🛑 Health server stopped');
        }
    }

    private async startHealthServer(): Promise<void> {
        const healthApp = express();

        // Basic health check endpoint
        healthApp.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                service: 'worker',
                timestamp: new Date().toISOString(),
                isPolling: this.isPolling,
                queueCount: this.queueUrls.length,
                lastHealthyTime: new Date(this.lastHealthyTime).toISOString(),
            });
        });

        // Deep health check that tests SQS connectivity
        healthApp.get('/health/deep', async (req, res) => {
            try {
                // Test SQS connectivity by checking if we can list messages (without receiving them)
                if (this.queueUrls.length > 0) {
                    const testCommand = new ReceiveMessageCommand({
                        QueueUrl: this.queueUrls[0],
                        MaxNumberOfMessages: 1,
                        WaitTimeSeconds: 1, // Quick check
                    });

                    await this.sqsClient.send(testCommand);
                }

                this.lastHealthyTime = Date.now();

                res.json({
                    status: 'healthy',
                    service: 'worker',
                    timestamp: new Date().toISOString(),
                    isPolling: this.isPolling,
                    queueCount: this.queueUrls.length,
                    sqsConnectivity: 'ok',
                    lastHealthyTime: new Date(this.lastHealthyTime).toISOString(),
                });
            } catch (error) {
                console.error('❌ Deep health check failed:', error);
                res.status(503).json({
                    status: 'unhealthy',
                    service: 'worker',
                    timestamp: new Date().toISOString(),
                    error: error instanceof Error ? error.message : 'Unknown error',
                    sqsConnectivity: 'failed',
                    lastHealthyTime: new Date(this.lastHealthyTime).toISOString(),
                });
            }
        });

        const healthPort = process.env.HEALTH_PORT || 8080;

        this.healthServer = healthApp.listen(healthPort, () => {
            console.log(`🏥 Worker health server started on port ${healthPort}`);
        });
    }

    private async ensureQueuesExist(): Promise<void> {
        // For LocalStack, we need to create queues if they don't exist
        if (!process.env.AWS_ENDPOINT_URL) {
            return; // Skip for real AWS - queues should already exist
        }

        const { CreateQueueCommand } = await import('@aws-sdk/client-sqs');

        for (const queueUrl of this.queueUrls) {
            try {
                const queueName = queueUrl.split('/').pop();
                await this.sqsClient.send(new CreateQueueCommand({ QueueName: queueName }));
                console.log(`✅ Ensured queue exists: ${queueName}`);
            } catch (error: any) {
                if (!error.message?.includes('already exists')) {
                    console.warn(`⚠️  Failed to create queue ${queueUrl}:`, error.message);
                }
            }
        }
    }

    private async pollQueue(queueUrl: string): Promise<void> {
        console.log(`🔄 Started polling queue: ${queueUrl}`);

        while (this.isPolling) {
            try {
                const command = new ReceiveMessageCommand({
                    QueueUrl: queueUrl,
                    // Keep fetch size modest; actual processing is gated by maxConcurrentJobs
                    MaxNumberOfMessages: 5,
                    WaitTimeSeconds: 20,
                    MessageAttributeNames: ['All'],
                });

                const response = await this.sqsClient.send(command);

                if (response.Messages && response.Messages.length > 0) {
                    console.log(`📥 Received ${response.Messages.length} messages from queue`);

                    // Process with bounded concurrency using internal gating
                    await Promise.all(
                        response.Messages.map(async (message) => {
                            await this.acquireSlot();
                            try {
                                await this.processMessage(queueUrl, message);
                            } finally {
                                this.releaseSlot();
                            }
                        }),
                    );
                }

                // Update health status - successful polling indicates health
                this.lastHealthyTime = Date.now();
            } catch (error) {
                console.error(`❌ Error polling queue ${queueUrl}:`, error);
                // Wait before retrying
                await this.sleep(5000);
            }
        }
    }

    private async processMessage(queueUrl: string, message: Message): Promise<void> {
        try {
            if (!message.Body || !message.ReceiptHandle) {
                console.warn('⚠️  Received message with no body or receipt handle');
                return;
            }

            const jobMessage: JobMessage = JSON.parse(message.Body);
            console.log(`🔨 Processing job: ${jobMessage.name} for chain ${jobMessage.chain}`);

            // Create a mock request/response for the job handler
            const mockReq = {
                body: jobMessage,
            } as express.Request;

            const mockRes = {
                sendStatus: (status: number) => {
                    console.log(`✅ Job completed with status: ${status}`);
                },
            } as express.Response;

            const mockNext = (error?: any) => {
                if (error) {
                    console.error(`❌ Job failed:`, error);
                    // Do not throw here; rejection is handled upstream by wrappedNext to avoid crashing the process
                }
            };

            // Process the job using existing job handlers
            await this.processJobMessage(mockReq, mockRes, mockNext);

            // Delete message from queue after successful processing
            await this.sqsClient.send(
                new DeleteMessageCommand({
                    QueueUrl: queueUrl,
                    ReceiptHandle: message.ReceiptHandle,
                }),
            );

            console.log(`🗑️  Message deleted from queue`);
        } catch (error) {
            console.error(`❌ Failed to process message:`, error);
            // Message will remain in queue and be retried or moved to DLQ
        }
    }

    private async acquireSlot(): Promise<void> {
        if (this.currentJobs < this.maxConcurrentJobs) {
            this.currentJobs += 1;
            return;
        }
        await new Promise<void>((resolve) => this.waitQueue.push(resolve));
        this.currentJobs += 1;
    }

    private releaseSlot(): void {
        this.currentJobs = Math.max(0, this.currentJobs - 1);
        const next = this.waitQueue.shift();
        if (next) next();
    }

    private async processJobMessage(
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            Sentry.withIsolationScope(async (scope) => {
                const job = req.body as JobMessage;
                const sentryTransactionName = `${job.name}-${job.chain}`;

                scope.clearBreadcrumbs();
                scope.setTransactionName(sentryTransactionName);
                scope.setTag('job', job.name);
                scope.setTag('chain', job.chain);

                const originalSendStatus = res.sendStatus;
                res.sendStatus = (status: number) => {
                    originalSendStatus.call(res, status);
                    if (status === 200) {
                        resolve();
                    } else {
                        reject(new Error(`Job failed with status: ${status}`));
                    }
                    return res;
                };

                const originalNext = next;
                const wrappedNext = (error?: any) => {
                    // Ensure original next is invoked for compatibility, but never allow a throw to escape
                    try {
                        originalNext(error);
                    } catch (e) {
                        // Swallow to prevent unhandled sync throws; we'll still reject below
                    }
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                };

                // Use existing job handler setup
                const { setupJobHandlers } = await import('./job-handlers');

                Sentry.startSpan({ op: 'job', name: sentryTransactionName }, async () => {
                    await setupJobHandlers(job.name, job.chain, res, wrappedNext);
                });
            });
        });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

export async function startSQSWorkerService(): Promise<void> {
    const worker = new SQSWorkerService();
    await worker.start();
}
