import { SendMessageCommand, SendMessageCommandInput, SQSClient } from '@aws-sdk/client-sqs';
import { AllNetworkConfigs } from '../../modules/network/network-config';
import { WorkerJob } from '../../modules/network/network-config-types';
import { isChainWhitelisted } from '../../modules/network/whitelisted-chains';
import { env } from '../env';

// Export for scheduler health tracking
export let lastSuccessfulSend = Date.now();

// Service validation helpers
function isValidUrl(url: string | undefined): boolean {
    if (!url || url.trim() === '') {
        return false;
    }

    // Check if it's a valid HTTP/HTTPS URL
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function validateJobDependencies(job: WorkerJob, chainId: string): { valid: boolean; reason?: string } {
    const config = AllNetworkConfigs[chainId];

    // Guard against missing config
    if (!config?.data?.subgraphs) {
        return {
            valid: false,
            reason: `Network configuration is incomplete for chain ${chainId}`,
        };
    }

    const subgraphs = config.data.subgraphs;

    // Jobs that depend on Balancer V2 subgraph
    const balancerV2Jobs = [
        'load-on-chain-data-for-pools-with-active-updates',
        'sync-new-pools-from-subgraph',
        'sync-changed-pools',
        'update-liquidity-24h-ago-v2',
        'sync-snapshots-v2',
        'sync-join-exits-v2',
        'sync-swaps-v2',
        'update-7-30-days-swap-apr',
        'update-liquidity-for-inactive-pools',
        'sync-tokens-from-pool-tokens',
        'cache-protocol-data', // Fantom specific, likely uses subgraph
    ];

    // Jobs that depend on Balancer V3 subgraph
    const balancerV3Jobs = [
        'add-pools-v3',
        'sync-pools-v3',
        'sync-join-exits-v3',
        'sync-swaps-v3',
        'sync-snapshots-v3',
        'update-liquidity-24h-ago-v3',
        'forward-fill-snapshots-v3',
        'sync-hook-data', // V3 hooks depend on V3 subgraph
        'update-pool-apr', // originally from balancerV2Jobs
    ];

    // Jobs that depend on COW AMM subgraph
    const cowAmmJobs = [
        'sync-cow-amm-pools',
        'sync-cow-amm-swaps',
        'sync-cow-amm-join-exits',
        'sync-cow-amm-snapshots',
    ];

    // Jobs that depend on Gauge subgraph
    const gaugeJobs = ['sync-staking-for-pools', 'sync-vebal-balances', 'sync-vebal-totalSupply'];

    // Jobs that depend on STS subgraph (Sonic specific)
    const stsJobs = ['sync-sts-staking-data', 'sync-sts-staking-snapshots'];

    // Jobs that depend on RPC access
    const rpcDependentJobs = [
        'update-token-prices',
        'sync-token-prices',
        'sync-erc4626-unwrap-rate',
        'sync-weights',
        'user-sync-wallet-balances-for-all-pools',
        'user-sync-staked-balances',
        'update-fee-volume-yield-all-pools',
    ];

    // Jobs that are monitoring/metrics (usually safe to run)
    const monitoringJobs = ['post-subgraph-lag-metrics'];

    // Validate dependencies
    if (balancerV2Jobs.includes(job.name)) {
        if (!isValidUrl(subgraphs.balancer)) {
            return {
                valid: false,
                reason: `Balancer V2 subgraph URL is not configured or invalid: "${subgraphs.balancer}"`,
            };
        }
    }

    if (balancerV3Jobs.includes(job.name)) {
        if (!isValidUrl(subgraphs.balancerV3)) {
            return {
                valid: false,
                reason: `Balancer V3 subgraph URL is not configured or invalid: "${subgraphs.balancerV3}"`,
            };
        }
    }

    if (cowAmmJobs.includes(job.name)) {
        if (!isValidUrl(subgraphs.cowAmm)) {
            return {
                valid: false,
                reason: `COW AMM subgraph URL is not configured or invalid: "${subgraphs.cowAmm}"`,
            };
        }
    }

    if (gaugeJobs.includes(job.name)) {
        if (!isValidUrl(subgraphs.gauge)) {
            return {
                valid: false,
                reason: `Gauge subgraph URL is not configured or invalid: "${subgraphs.gauge}"`,
            };
        }
    }

    if (stsJobs.includes(job.name)) {
        if (!isValidUrl(subgraphs.sts)) {
            return {
                valid: false,
                reason: `STS subgraph URL is not configured or invalid: "${subgraphs.sts}"`,
            };
        }
    }

    if (rpcDependentJobs.includes(job.name)) {
        if (!isValidUrl(config.data.rpcUrl)) {
            return {
                valid: false,
                reason: `RPC URL is not configured or invalid: "${config.data.rpcUrl}"`,
            };
        }
    }

    // Monitoring jobs are usually safe to run
    if (monitoringJobs.includes(job.name)) {
        return { valid: true };
    }

    // Check for unknown jobs - this is critical for safety
    const allKnownJobs = [
        ...balancerV2Jobs,
        ...balancerV3Jobs,
        ...cowAmmJobs,
        ...gaugeJobs,
        ...stsJobs,
        ...rpcDependentJobs,
        ...monitoringJobs,
    ];

    if (!allKnownJobs.includes(job.name)) {
        // Log unknown job but allow it for now (non-breaking)
        console.warn(`⚠️  Unknown job "${job.name}" for chain ${chainId} - allowing but please review dependencies`);
        return { valid: true };
    }

    return { valid: true };
}

class WorkerQueue {
    private client: SQSClient;
    private backgroundJobQueueUrl?: string;
    private dataRefreshQueueUrl?: string;
    private notificationQueueUrl?: string;

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

        this.client = new SQSClient(sqsConfig);

        // Get queue URLs from environment
        this.backgroundJobQueueUrl = process.env.SQS_BACKGROUND_JOB_QUEUE_URL;
        this.dataRefreshQueueUrl = process.env.SQS_DATA_REFRESH_QUEUE_URL;
        this.notificationQueueUrl = process.env.SQS_NOTIFICATION_QUEUE_URL;

        // Debug: Log the queue URLs being used
        console.log('🔍 SQS Queue URLs loaded:');
        console.log(`   Background Job Queue: ${this.backgroundJobQueueUrl || 'NOT SET'}`);
        console.log(`   Data Refresh Queue: ${this.dataRefreshQueueUrl || 'NOT SET'}`);
        console.log(`   Notification Queue: ${this.notificationQueueUrl || 'NOT SET'}`);
        console.log(`   AWS Endpoint: ${process.env.AWS_ENDPOINT_URL || 'NOT SET'}`);
    }

    public async sendWithInterval(json: string, intervalMs: number, deDuplicationId?: string): Promise<void> {
        try {
            // Default to background job queue
            const queueUrl = this.backgroundJobQueueUrl;

            if (!queueUrl) {
                console.warn('⚠️  No background job queue URL configured. Skipping job scheduling.');
                return;
            }

            console.log(`🔍 About to send message to queue URL: ${queueUrl}`);
            await this.sendMessage(queueUrl, json, deDuplicationId);
            console.log(`📤 Sent message to SQS queue: ${json}`);
        } catch (error) {
            console.error('❌ Error sending message to SQS:', error);
            console.error(`🔍 Failed queue URL was: ${this.backgroundJobQueueUrl}`);
        } finally {
            setTimeout(() => {
                this.sendWithInterval(json, intervalMs, deDuplicationId);
            }, intervalMs);
        }
    }

    private async sendMessage(
        queueUrl: string,
        json: string,
        deDuplicationId?: string,
        delaySeconds?: number,
    ): Promise<void> {
        console.log(`🔍 Sending message to queue: ${queueUrl}`);
        const input: SendMessageCommandInput = {
            QueueUrl: queueUrl,
            MessageBody: json,
            MessageDeduplicationId: deDuplicationId,
            DelaySeconds: delaySeconds,
        };
        const command = new SendMessageCommand(input);
        await this.client.send(command);

        // Update last successful send time for health tracking
        lastSuccessfulSend = Date.now();
    }

    public async sendToDataRefreshQueue(json: string, deDuplicationId?: string): Promise<void> {
        if (this.dataRefreshQueueUrl) {
            await this.sendMessage(this.dataRefreshQueueUrl, json, deDuplicationId);
        }
    }

    public async sendToNotificationQueue(json: string, deDuplicationId?: string): Promise<void> {
        if (this.notificationQueueUrl) {
            await this.sendMessage(this.notificationQueueUrl, json, deDuplicationId);
        }
    }
}

const workerQueue = new WorkerQueue();

export async function scheduleJobs(chainId: string): Promise<void> {
    // Safety check: ensure the chain is whitelisted before scheduling jobs
    if (!isChainWhitelisted(chainId)) {
        console.warn(`⚠️  Attempted to schedule jobs for non-whitelisted chain: ${chainId}. Skipping.`);
        return;
    }

    console.log(`🕐 Initializing job scheduling for chain ${chainId}...`);

    const allJobs = AllNetworkConfigs[chainId].workerJobs;
    const validJobs: WorkerJob[] = [];
    const skippedJobs: { job: WorkerJob; reason: string }[] = [];

    // Validate each job's service dependencies
    for (const job of allJobs) {
        const validation = validateJobDependencies(job, chainId);

        if (validation.valid) {
            validJobs.push(job);
        } else {
            skippedJobs.push({ job, reason: validation.reason! });
        }
    }

    // Log validation results
    if (skippedJobs.length > 0) {
        console.warn(
            `⚠️  Skipping ${skippedJobs.length} jobs for chain ${chainId} due to invalid service configurations:`,
        );
        skippedJobs.forEach(({ job, reason }) => {
            console.warn(`   ❌ ${job.name}: ${reason}`);
        });
    }

    // Schedule only valid jobs
    for (const job of validJobs) {
        console.log(`📋 Scheduling job: ${job.name}-${chainId} (interval: ${job.interval}ms)`);
        await workerQueue.sendWithInterval(JSON.stringify({ name: job.name, chain: chainId }), job.interval);
    }

    console.log(
        `✅ Job scheduling initialized for chain ${chainId}: ${validJobs.length} jobs scheduled, ${skippedJobs.length} jobs skipped`,
    );
}
