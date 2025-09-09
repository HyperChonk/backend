import { Resolvers } from '../generated-schema';
// Temporarily using basic console for debugging log forwarding issues
// import { enhancedConsole, createJobLogger } from '../../../simple-logging';

const debugResolvers: Resolvers = {
    Query: {
        debugTestLogs: async (
            parent: any,
            { level = 'info', message = 'Test log message', includeMetadata = true },
            context: any,
        ) => {
            const timestamp = new Date().toISOString();
            const logMessage = `[DEBUG-TEST] ${message}`;

            // Test metadata logging with basic console
            const metadata = includeMetadata
                ? {
                      requestId: `debug_${Date.now()}`,
                      userAgent: context.request?.headers?.['user-agent'] || 'unknown',
                      ip: context.ip || 'unknown',
                      endpoint: 'debugTestLogs',
                      environment: process.env.DEPLOYMENT_ENV || 'development',
                  }
                : {};

            // Use basic console methods for testing log forwarding
            const fullMessage = `${logMessage} ${includeMetadata ? JSON.stringify(metadata) : ''}`;

            switch (level.toLowerCase()) {
                case 'error':
                    console.error(fullMessage);
                    break;
                case 'warn':
                    console.warn(fullMessage);
                    break;
                case 'debug':
                    console.debug(fullMessage);
                    break;
                case 'info':
                default:
                    console.log(fullMessage);
                    break;
            }

            return {
                success: true,
                message: `Log generated at ${level} level: ${logMessage}`,
                timestamp,
                logLevel: level,
            };
        },

        debugBulkTestLogs: async (parent: any, { count = 5, levels = ['info', 'warn', 'error'] }, context: any) => {
            const results = [];
            const requestId = `bulk_debug_${Date.now()}`;

            for (let i = 0; i < count; i++) {
                const level = levels[i % levels.length];
                const timestamp = new Date().toISOString();
                const message = `Bulk test log ${i + 1}/${count}`;
                const logMessage = `[DEBUG-BULK-TEST] ${message}`;

                const metadata = {
                    requestId,
                    bulkIndex: i + 1,
                    bulkTotal: count,
                    ip: context.ip || 'unknown',
                    endpoint: 'debugBulkTestLogs',
                };

                // Use basic console methods for testing
                const fullMessage = `${logMessage} ${JSON.stringify(metadata)}`;

                switch (level.toLowerCase()) {
                    case 'error':
                        console.error(fullMessage);
                        break;
                    case 'warn':
                        console.warn(fullMessage);
                        break;
                    case 'debug':
                        console.debug(fullMessage);
                        break;
                    case 'info':
                    default:
                        console.log(fullMessage);
                        break;
                }

                results.push({
                    success: true,
                    message: `Bulk log ${i + 1}: ${logMessage}`,
                    timestamp,
                    logLevel: level,
                });

                // Small delay between logs to avoid overwhelming
                if (i < count - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }

            // Summary log
            console.log(
                `[DEBUG-BULK-TEST] Bulk log test completed - requestId: ${requestId}, totalLogs: ${count}, levels: ${levels.join(
                    ', ',
                )}`,
            );

            return results;
        },

        debugTestStructuredLogs: async (
            parent: any,
            { jobName = 'test-job', chainId = '1', simulateJobFlow = true },
            context: any,
        ) => {
            const results = [];
            const timestamp = new Date().toISOString();

            if (simulateJobFlow) {
                // Simulate a complete job flow using basic console patterns that the Lambda expects
                const requestId = `debug_${Date.now()}`;

                // Start job - using the pattern the Lambda looks for
                console.log(`Start job ${jobName}-${chainId}-start`);
                results.push({
                    success: true,
                    message: `Job ${jobName} started for chain ${chainId}`,
                    timestamp: new Date().toISOString(),
                    logLevel: 'info',
                });

                // Simulate some progress
                await new Promise((resolve) => setTimeout(resolve, 200));
                console.log(`Processing test data (1/3)`);
                results.push({
                    success: true,
                    message: `Job ${jobName} progress: step 1/3`,
                    timestamp: new Date().toISOString(),
                    logLevel: 'info',
                });

                await new Promise((resolve) => setTimeout(resolve, 200));
                console.log(`Validating test results (2/3)`);
                results.push({
                    success: true,
                    message: `Job ${jobName} progress: step 2/3`,
                    timestamp: new Date().toISOString(),
                    logLevel: 'info',
                });

                await new Promise((resolve) => setTimeout(resolve, 200));
                console.log(`Finalizing test job (3/3)`);
                results.push({
                    success: true,
                    message: `Job ${jobName} progress: step 3/3`,
                    timestamp: new Date().toISOString(),
                    logLevel: 'info',
                });

                // Complete job - using the pattern the Lambda looks for
                console.log(`Successful job ${jobName}-${chainId}-done`, 0.6);
                results.push({
                    success: true,
                    message: `Job ${jobName} completed for chain ${chainId}`,
                    timestamp: new Date().toISOString(),
                    logLevel: 'info',
                });

                // Test warning and error logs
                console.warn(`[DEBUG-STRUCTURED-TEST] Test warning log - jobName: ${jobName}, chainId: ${chainId}`);
                results.push({
                    success: true,
                    message: `Warning log generated for job ${jobName}`,
                    timestamp: new Date().toISOString(),
                    logLevel: 'warn',
                });

                console.error(
                    `[DEBUG-STRUCTURED-TEST] Test error log (not a real error) - jobName: ${jobName}, chainId: ${chainId}`,
                );
                results.push({
                    success: true,
                    message: `Error log generated for job ${jobName} (test only)`,
                    timestamp: new Date().toISOString(),
                    logLevel: 'error',
                });
            } else {
                // Just log a simple structured message
                console.log(
                    `[DEBUG-STRUCTURED-TEST] Simple structured log test - jobName: ${jobName}, chainId: ${chainId}, testType: simple, timestamp: ${timestamp}`,
                );
                results.push({
                    success: true,
                    message: `Simple structured log for job ${jobName}`,
                    timestamp,
                    logLevel: 'info',
                });
            }

            return results;
        },
    },
};

export default debugResolvers;
