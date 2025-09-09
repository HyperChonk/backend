import {
    CloudWatchLogsClient,
    DescribeLogStreamsCommand,
    GetLogEventsCommand,
    LogStream,
    OutputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import { ECSClient, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';

export interface LogDebugResult {
    source: string;
    hasLogs: boolean;
    recentLogs?: OutputLogEvent[];
    errorPatterns?: string[];
    summary: string;
    recommendations: string[];
    logStreamName?: string;
    error?: string;
}

export interface ECSLogDebugOptions {
    clusterArn: string;
    serviceName: string;
    environment: string;
    maxLogEvents?: number;
    lookbackMinutes?: number;
}

export interface CloudFormationLogDebugOptions {
    stackName: string;
    environment: string;
    maxLogEvents?: number;
    lookbackMinutes?: number;
}

export class LogDebugger {
    private cloudwatchLogsClient: CloudWatchLogsClient;
    private ecsClient: ECSClient;
    private region: string;

    constructor(region: string = 'us-east-1') {
        this.region = region;
        this.cloudwatchLogsClient = new CloudWatchLogsClient({ region });
        this.ecsClient = new ECSClient({ region });
    }

    /**
     * Debug logs for an unhealthy ECS service
     */
    async debugECSServiceLogs(options: ECSLogDebugOptions): Promise<LogDebugResult[]> {
        const results: LogDebugResult[] = [];
        const { clusterArn, serviceName, environment, maxLogEvents = 50, lookbackMinutes = 30 } = options;

        try {
            // Get recent stopped/failed tasks
            const stoppedTasks = await this.ecsClient.send(
                new ListTasksCommand({
                    cluster: clusterArn,
                    serviceName: serviceName,
                    desiredStatus: 'STOPPED',
                }),
            );

            // Get current running tasks
            const runningTasks = await this.ecsClient.send(
                new ListTasksCommand({
                    cluster: clusterArn,
                    serviceName: serviceName,
                    desiredStatus: 'RUNNING',
                }),
            );

            // Analyze stopped tasks (failures)
            if (stoppedTasks.taskArns?.length) {
                const recentStoppedTasks = stoppedTasks.taskArns.slice(0, 3);
                const taskDetails = await this.ecsClient.send(
                    new DescribeTasksCommand({
                        cluster: clusterArn,
                        tasks: recentStoppedTasks,
                    }),
                );

                for (const task of taskDetails.tasks || []) {
                    const taskId = task.taskArn?.split('/').pop() || 'unknown';
                    const logGroupName = `/v3-backend/${environment}/api`;

                    const logResult = await this.getTaskLogs({
                        taskId,
                        logGroupName,
                        maxLogEvents,
                        lookbackMinutes,
                        taskDetails: {
                            stoppedReason: task.stoppedReason,
                            exitCode: task.containers?.[0]?.exitCode,
                            containerReason: task.containers?.[0]?.reason,
                            lastStatus: task.lastStatus,
                        },
                    });

                    results.push(logResult);
                }
            }

            // Analyze running tasks (current issues)
            if (runningTasks.taskArns?.length) {
                const taskDetails = await this.ecsClient.send(
                    new DescribeTasksCommand({
                        cluster: clusterArn,
                        tasks: runningTasks.taskArns.slice(0, 2), // Check first 2 running tasks
                    }),
                );

                for (const task of taskDetails.tasks || []) {
                    const taskId = task.taskArn?.split('/').pop() || 'unknown';
                    const logGroupName = `/v3-backend/${environment}/api`;

                    const logResult = await this.getTaskLogs({
                        taskId,
                        logGroupName,
                        maxLogEvents,
                        lookbackMinutes: 10, // Shorter lookback for running tasks
                        taskDetails: {
                            healthStatus: task.healthStatus,
                            lastStatus: task.lastStatus,
                            desiredStatus: task.desiredStatus,
                        },
                    });

                    if (logResult.hasLogs) {
                        results.push(logResult);
                    }
                }
            }

            // If no task-specific logs, try to get service-level logs
            if (results.length === 0) {
                const serviceLogResult = await this.getServiceLogs({
                    serviceName,
                    environment,
                    maxLogEvents,
                    lookbackMinutes,
                });
                results.push(serviceLogResult);
            }
        } catch (error) {
            results.push({
                source: `ECS Service ${serviceName}`,
                hasLogs: false,
                summary: 'Failed to retrieve ECS service logs',
                recommendations: ['Check ECS service permissions', 'Verify log group exists'],
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }

        return results;
    }

    /**
     * Get logs for a specific ECS task
     */
    private async getTaskLogs(options: {
        taskId: string;
        logGroupName: string;
        maxLogEvents: number;
        lookbackMinutes: number;
        taskDetails?: any;
    }): Promise<LogDebugResult> {
        const { taskId, logGroupName, maxLogEvents, lookbackMinutes, taskDetails } = options;

        try {
            // Find log stream for this task
            const logStreamPrefix = `ecs/v3-backend-api/${taskId}`;
            const streamsResponse = await this.cloudwatchLogsClient.send(
                new DescribeLogStreamsCommand({
                    logGroupName,
                    logStreamNamePrefix: logStreamPrefix,
                    orderBy: 'LastEventTime',
                    descending: true,
                    limit: 1,
                }),
            );

            if (!streamsResponse.logStreams?.length) {
                return {
                    source: `Task ${taskId}`,
                    hasLogs: false,
                    summary: `No log stream found for task ${taskId}`,
                    recommendations: [
                        'Task may have failed before logging started',
                        'Check if log group configuration is correct',
                        'Verify CloudWatch logs permissions',
                    ],
                };
            }

            const logStream = streamsResponse.logStreams[0];
            const startTime = Date.now() - lookbackMinutes * 60 * 1000;

            const eventsResponse = await this.cloudwatchLogsClient.send(
                new GetLogEventsCommand({
                    logGroupName,
                    logStreamName: logStream.logStreamName!,
                    startTime,
                    limit: maxLogEvents,
                }),
            );

            const events = eventsResponse.events || [];
            const errorPatterns = this.analyzeLogEvents(events);
            const summary = this.generateTaskSummary(taskId, events, errorPatterns, taskDetails);
            const recommendations = this.generateTaskRecommendations(errorPatterns, taskDetails);

            return {
                source: `Task ${taskId}`,
                hasLogs: events.length > 0,
                recentLogs: events.slice(-10), // Last 10 events
                errorPatterns,
                summary,
                recommendations,
                logStreamName: logStream.logStreamName,
            };
        } catch (error) {
            return {
                source: `Task ${taskId}`,
                hasLogs: false,
                summary: `Failed to retrieve logs for task ${taskId}`,
                recommendations: ['Check CloudWatch logs permissions', 'Verify log group exists'],
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    /**
     * Get general service logs when task-specific logs aren't available
     */
    private async getServiceLogs(options: {
        serviceName: string;
        environment: string;
        maxLogEvents: number;
        lookbackMinutes: number;
    }): Promise<LogDebugResult> {
        const { serviceName, environment, maxLogEvents, lookbackMinutes } = options;
        const logGroupName = `/v3-backend/${environment}/api`;

        try {
            // Get most recent log streams
            const streamsResponse = await this.cloudwatchLogsClient.send(
                new DescribeLogStreamsCommand({
                    logGroupName,
                    orderBy: 'LastEventTime',
                    descending: true,
                    limit: 3,
                }),
            );

            if (!streamsResponse.logStreams?.length) {
                return {
                    source: `Service ${serviceName}`,
                    hasLogs: false,
                    summary: `No log streams found in ${logGroupName}`,
                    recommendations: [
                        'Service may never have started successfully',
                        'Check if log group exists and is configured correctly',
                        'Verify ECS task execution role has CloudWatch logs permissions',
                    ],
                };
            }

            const mostRecentStream = streamsResponse.logStreams[0];
            const startTime = Date.now() - lookbackMinutes * 60 * 1000;

            const eventsResponse = await this.cloudwatchLogsClient.send(
                new GetLogEventsCommand({
                    logGroupName,
                    logStreamName: mostRecentStream.logStreamName!,
                    startTime,
                    limit: maxLogEvents,
                }),
            );

            const events = eventsResponse.events || [];
            const errorPatterns = this.analyzeLogEvents(events);
            const summary = this.generateServiceSummary(serviceName, events, errorPatterns);
            const recommendations = this.generateServiceRecommendations(errorPatterns);

            return {
                source: `Service ${serviceName}`,
                hasLogs: events.length > 0,
                recentLogs: events.slice(-15), // Last 15 events
                errorPatterns,
                summary,
                recommendations,
                logStreamName: mostRecentStream.logStreamName,
            };
        } catch (error) {
            return {
                source: `Service ${serviceName}`,
                hasLogs: false,
                summary: `Failed to retrieve service logs`,
                recommendations: ['Check CloudWatch logs permissions', 'Verify log group exists'],
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    /**
     * Analyze log events for common error patterns
     */
    private analyzeLogEvents(events: OutputLogEvent[]): string[] {
        const patterns: string[] = [];
        const errorKeywords = [
            'error',
            'exception',
            'failed',
            'timeout',
            'refused',
            'denied',
            'cannot',
            'unable',
            'missing',
            'invalid',
            'unauthorized',
        ];

        const databaseKeywords = ['database', 'connection', 'prisma', 'postgresql', 'db', 'pool'];

        const startupKeywords = ['starting', 'initializing', 'connecting', 'listening', 'ready'];

        let hasErrors = false;
        let hasDatabaseIssues = false;
        let hasStartupIssues = false;
        let hasHealthCheckIssues = false;

        for (const event of events) {
            const message = event.message?.toLowerCase() || '';

            // Check for general errors
            if (errorKeywords.some((keyword) => message.includes(keyword))) {
                hasErrors = true;
            }

            // Check for database issues
            if (
                databaseKeywords.some((keyword) => message.includes(keyword)) &&
                errorKeywords.some((keyword) => message.includes(keyword))
            ) {
                hasDatabaseIssues = true;
            }

            // Check for startup issues
            if (
                startupKeywords.some((keyword) => message.includes(keyword)) &&
                errorKeywords.some((keyword) => message.includes(keyword))
            ) {
                hasStartupIssues = true;
            }

            // Check for health check issues
            if (message.includes('health') && errorKeywords.some((keyword) => message.includes(keyword))) {
                hasHealthCheckIssues = true;
            }
        }

        if (hasErrors) patterns.push('Application errors detected');
        if (hasDatabaseIssues) patterns.push('Database connection issues');
        if (hasStartupIssues) patterns.push('Application startup failures');
        if (hasHealthCheckIssues) patterns.push('Health check endpoint issues');

        // Check if no startup messages at all
        const hasStartupMessages = events.some((event) =>
            startupKeywords.some((keyword) => event.message?.toLowerCase().includes(keyword)),
        );
        if (!hasStartupMessages && events.length > 0) {
            patterns.push('Application may not be starting properly');
        }

        return patterns;
    }

    /**
     * Generate summary for task logs
     */
    private generateTaskSummary(
        taskId: string,
        events: OutputLogEvent[],
        patterns: string[],
        taskDetails?: any,
    ): string {
        if (events.length === 0) {
            return `Task ${taskId} produced no logs - likely failed before application startup`;
        }

        const exitInfo = taskDetails?.exitCode ? ` (exit code: ${taskDetails.exitCode})` : '';
        const reasonInfo = taskDetails?.stoppedReason ? ` - ${taskDetails.stoppedReason}` : '';

        if (patterns.length > 0) {
            return `Task ${taskId} failed${exitInfo}${reasonInfo}. Issues: ${patterns.join(', ')}`;
        }

        return `Task ${taskId} logs available${exitInfo}${reasonInfo} - ${events.length} log entries found`;
    }

    /**
     * Generate summary for service logs
     */
    private generateServiceSummary(serviceName: string, events: OutputLogEvent[], patterns: string[]): string {
        if (events.length === 0) {
            return `Service ${serviceName} has no recent logs`;
        }

        if (patterns.length > 0) {
            return `Service ${serviceName} logs show issues: ${patterns.join(', ')}`;
        }

        return `Service ${serviceName} logs available - ${events.length} recent entries`;
    }

    /**
     * Generate recommendations based on detected patterns
     */
    private generateTaskRecommendations(patterns: string[], taskDetails?: any): string[] {
        const recommendations: string[] = [];

        if (patterns.includes('Database connection issues')) {
            recommendations.push('Check DATABASE_URL secret value and format');
            recommendations.push('Verify RDS instance is available and accessible');
            recommendations.push('Check security group rules for database access');
        }

        if (patterns.includes('Application startup failures')) {
            recommendations.push('Check required environment variables and secrets');
            recommendations.push('Verify application dependencies and configuration');
            recommendations.push('Check if database migrations need to be run');
        }

        if (patterns.includes('Health check endpoint issues')) {
            recommendations.push('Verify /health endpoint is implemented and responding');
            recommendations.push('Check if application is binding to correct port (4000)');
            recommendations.push('Consider increasing health check timeout or start period');
        }

        if (patterns.includes('Application may not be starting properly')) {
            recommendations.push('Check if application entry point is correct');
            recommendations.push('Verify container image and startup command');
            recommendations.push('Check for missing dependencies or configuration');
        }

        // Exit code specific recommendations
        if (taskDetails?.exitCode === 137) {
            recommendations.push('Exit code 137 suggests container was killed - possibly OOM or timeout');
            recommendations.push('Consider increasing memory allocation for the task');
        }

        if (taskDetails?.exitCode === 1) {
            recommendations.push('Exit code 1 indicates application error - check logs for specific errors');
        }

        if (recommendations.length === 0) {
            recommendations.push('Check recent log entries for specific error details');
            recommendations.push('Verify all required secrets and environment variables are accessible');
        }

        return recommendations;
    }

    /**
     * Generate recommendations for service-level issues
     */
    private generateServiceRecommendations(patterns: string[]): string[] {
        const recommendations: string[] = [];

        if (patterns.includes('Database connection issues')) {
            recommendations.push('Check if database is accessible from ECS tasks');
            recommendations.push('Verify DATABASE_URL secret is correct');
        }

        if (patterns.includes('Application errors detected')) {
            recommendations.push('Review recent error messages in logs');
            recommendations.push('Check application configuration and dependencies');
        }

        if (recommendations.length === 0) {
            recommendations.push('Review recent log entries for error details');
            recommendations.push('Check ECS service events for deployment issues');
        }

        return recommendations;
    }

    /**
     * Format log debug results for display
     */
    static formatLogDebugResults(results: LogDebugResult[]): string {
        let output = '';

        for (const result of results) {
            output += `\n📋 ${result.source}:\n`;
            output += `   ${result.hasLogs ? '✅' : '❌'} ${result.summary}\n`;

            if (result.errorPatterns?.length) {
                output += `   🔍 Detected issues: ${result.errorPatterns.join(', ')}\n`;
            }

            if (result.recommendations.length > 0) {
                output += `   💡 Recommendations:\n`;
                for (const rec of result.recommendations.slice(0, 3)) {
                    output += `     • ${rec}\n`;
                }
            }

            if (result.recentLogs?.length) {
                output += `   📜 Recent log entries:\n`;
                for (const logEvent of result.recentLogs.slice(-5)) {
                    const timestamp = new Date(logEvent.timestamp || 0).toISOString().substring(11, 19);
                    const message = logEvent.message?.substring(0, 100) || '';
                    output += `     ${timestamp}: ${message}${message.length >= 100 ? '...' : ''}\n`;
                }
            }

            if (result.logStreamName) {
                output += `   🔗 Log stream: ${result.logStreamName}\n`;
            }
        }

        return output;
    }
}
