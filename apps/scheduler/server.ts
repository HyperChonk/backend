import { env } from '../env';
import { sleep } from '../../modules/common/promise';
import { scheduleJobs, lastSuccessfulSend } from './job-queue';
import { createAlerts } from './create-alerts';
import { getWhitelistedChains } from '../../modules/network/whitelisted-chains';
import express from 'express';
import http from 'http';
import { SQSClient, ListQueuesCommand } from '@aws-sdk/client-sqs';
// import { createMonitors } from './create-monitors';

// Initialize structured logging for all environments
// In development: readable console output
// In staging/production: structured JSON for Loki
// const { enableGlobalStructuredLogging } = require('../simple-logging');
// enableGlobalStructuredLogging();
// console.log(`✅ Structured logging enabled for scheduler service (${process.env.DEPLOYMENT_ENV})`);

let healthServer: http.Server | null = null;
let lastHealthyTime = Date.now();
let isSchedulingActive = false;
let scheduledChains: string[] = [];

async function startHealthServer(): Promise<void> {
    const healthApp = express();

    // Basic health check endpoint
    healthApp.get('/health', (req, res) => {
        res.json({
            status: 'healthy',
            service: 'scheduler',
            timestamp: new Date().toISOString(),
            isSchedulingActive,
            scheduledChainCount: scheduledChains.length,
            scheduledChains,
            lastHealthyTime: new Date(lastHealthyTime).toISOString(),
            lastSuccessfulSend: new Date(lastSuccessfulSend).toISOString(),
        });
    });

    // Deep health check that tests SQS connectivity
    healthApp.get('/health/deep', async (req, res) => {
        try {
            // Test SQS connectivity by listing queues
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

            const sqsClient = new SQSClient(sqsConfig);

            // Quick SQS connectivity test
            await sqsClient.send(new ListQueuesCommand({}));

            lastHealthyTime = Date.now();

            res.json({
                status: 'healthy',
                service: 'scheduler',
                timestamp: new Date().toISOString(),
                isSchedulingActive,
                scheduledChainCount: scheduledChains.length,
                scheduledChains,
                sqsConnectivity: 'ok',
                lastHealthyTime: new Date(lastHealthyTime).toISOString(),
                lastSuccessfulSend: new Date(lastSuccessfulSend).toISOString(),
            });
        } catch (error) {
            console.error('❌ Scheduler deep health check failed:', error);
            res.status(503).json({
                status: 'unhealthy',
                service: 'scheduler',
                timestamp: new Date().toISOString(),
                error: error instanceof Error ? error.message : 'Unknown error',
                sqsConnectivity: 'failed',
                isSchedulingActive,
                scheduledChainCount: scheduledChains.length,
                lastHealthyTime: new Date(lastHealthyTime).toISOString(),
                lastSuccessfulSend: new Date(lastSuccessfulSend).toISOString(),
            });
        }
    });

    const healthPort = process.env.HEALTH_PORT || 8081;

    healthServer = healthApp.listen(healthPort, () => {
        console.log(`🏥 Scheduler health server started on port ${healthPort}`);
    });
}

export async function startSchedulerServer() {
    try {
        // Start health server first
        await startHealthServer();

        const chainIds = getWhitelistedChains();
        console.log(`✅ Scheduler starting for whitelisted chains: ${chainIds.join(', ')}`);

        scheduledChains = chainIds;
        isSchedulingActive = true;

        for (const chainId of chainIds) {
            scheduleJobs(chainId);
            if (process.env.AWS_ALERTS === 'true') {
                await createAlerts(chainId);
            }
            // await createMonitors(chainId);
            await sleep(5000);
        }

        // Update health status after successful scheduling
        lastHealthyTime = Date.now();
    } catch (e) {
        console.error(`Fatal error happened during cron scheduling.`, e);
        isSchedulingActive = false;
        throw e;
    }
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Stopping Scheduler Service...');
    isSchedulingActive = false;

    if (healthServer) {
        healthServer.close();
        console.log('🛑 Scheduler health server stopped');
    }
});

process.on('SIGINT', () => {
    console.log('🛑 Stopping Scheduler Service...');
    isSchedulingActive = false;

    if (healthServer) {
        healthServer.close();
        console.log('🛑 Scheduler health server stopped');
    }
});
