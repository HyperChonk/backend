import { startSQSWorkerService } from './sqs-worker';

// Initialize structured logging for all environments
// In development: readable console output
// In staging/production: structured JSON for Loki
// const { enableGlobalStructuredLogging } = require('../simple-logging');
// enableGlobalStructuredLogging();
// console.log(`✅ Structured logging enabled for worker service (${process.env.DEPLOYMENT_ENV})`);

export async function startWorkerServer() {
    // Global safety nets to prevent hard exits on unhandled async errors
    process.on('unhandledRejection', (reason: unknown) => {
        console.error('⚠️  Unhandled promise rejection in worker:', reason);
    });
    process.on('uncaughtException', (error: Error) => {
        console.error('⚠️  Uncaught exception in worker:', error);
    });

    console.log('🚀 Starting Worker Service with SQS polling...');
    await startSQSWorkerService();
}
