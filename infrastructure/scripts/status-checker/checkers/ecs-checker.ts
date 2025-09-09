import {
    ECSClient,
    DescribeClustersCommand,
    DescribeServicesCommand,
    ListClustersCommand,
    ListServicesCommand,
    DescribeTasksCommand,
    ListTasksCommand,
} from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { StatusResult, DeploymentIssue, CheckResult } from '../types';
import { LogDebugger, LogDebugResult } from '../utils/log-debugger';

export class ECSChecker {
    private ecsClient: ECSClient;
    private rdsClient: RDSClient;
    private cloudwatchLogsClient: CloudWatchLogsClient;
    private logDebugger: LogDebugger;
    private environment: string;

    constructor(region: string, environment: string) {
        this.ecsClient = new ECSClient({ region });
        this.rdsClient = new RDSClient({ region });
        this.cloudwatchLogsClient = new CloudWatchLogsClient({ region });
        this.logDebugger = new LogDebugger(region);
        this.environment = environment;
    }

    private createResult(
        service: string,
        category: StatusResult['category'],
        status: StatusResult['status'],
        message: string,
        details?: any,
    ): StatusResult {
        return {
            service,
            category,
            status,
            message,
            details,
            timestamp: new Date().toISOString(),
        };
    }

    async getRecentTaskFailures(clusterArn: string, serviceName: string): Promise<any> {
        try {
            // Get recent stopped tasks
            const stoppedTasks = await this.ecsClient.send(
                new ListTasksCommand({
                    cluster: clusterArn,
                    serviceName: serviceName,
                    desiredStatus: 'STOPPED',
                }),
            );

            if (!stoppedTasks.taskArns?.length) {
                return { failures: [], summary: 'No recent task failures' };
            }

            // Get details of the 3 most recent stopped tasks
            const recentTasks = stoppedTasks.taskArns.slice(0, 3);
            const taskDetails = await this.ecsClient.send(
                new DescribeTasksCommand({
                    cluster: clusterArn,
                    tasks: recentTasks,
                }),
            );

            const failures = (taskDetails.tasks || []).map((task) => ({
                taskArn: task.taskArn?.split('/').pop(), // Just the ID part
                stoppedAt: task.stoppedAt,
                stoppedReason: task.stoppedReason,
                stopCode: task.stopCode,
                exitCode: task.containers?.[0]?.exitCode,
                containerReason: task.containers?.[0]?.reason,
                healthStatus: task.healthStatus,
            }));

            // Analyze common failure patterns
            const patterns = [];
            if (failures.some((f) => f.exitCode === 1)) {
                patterns.push('Application crashes (exit code 1)');
            }
            if (failures.some((f) => f.stoppedReason?.includes('HealthCheck'))) {
                patterns.push('Health check failures');
            }
            if (failures.some((f) => f.stoppedReason?.includes('OutOfMemory'))) {
                patterns.push('Out of memory errors');
            }
            if (failures.some((f) => f.stoppedReason?.includes('TaskFailedToStart'))) {
                patterns.push('Tasks failing to start');
            }

            return {
                failures: failures.slice(0, 2), // Show only 2 most recent
                patterns,
                summary: patterns.length > 0 ? `Common issues: ${patterns.join(', ')}` : 'No obvious patterns detected',
            };
        } catch (error) {
            return { error: error instanceof Error ? error.message : 'Unknown error' };
        }
    }

    /**
     * Check for ECR pull permission issues by analyzing task failures and IAM roles
     */
    async checkECRPermissions(clusterArn: string, serviceName: string): Promise<any> {
        try {
            // Get recent stopped tasks to check for ECR-related failures
            const stoppedTasks = await this.ecsClient.send(
                new ListTasksCommand({
                    cluster: clusterArn,
                    serviceName: serviceName,
                    desiredStatus: 'STOPPED',
                }),
            );

            if (!stoppedTasks.taskArns?.length) {
                return { hasECRIssues: false, details: 'No recent task failures to analyze' };
            }

            // Get details of recent stopped tasks
            const recentTasks = stoppedTasks.taskArns.slice(0, 5);
            const taskDetails = await this.ecsClient.send(
                new DescribeTasksCommand({
                    cluster: clusterArn,
                    tasks: recentTasks,
                }),
            );

            const ecrRelatedFailures = (taskDetails.tasks || []).filter((task) => {
                const stoppedReason = task.stoppedReason?.toLowerCase() || '';
                const containerReason = task.containers?.[0]?.reason?.toLowerCase() || '';

                return (
                    stoppedReason.includes('cannot pull container image') ||
                    stoppedReason.includes('ecr') ||
                    stoppedReason.includes('authorization') ||
                    stoppedReason.includes('access denied') ||
                    containerReason.includes('pull image') ||
                    containerReason.includes('ecr') ||
                    containerReason.includes('authorization')
                );
            });

            if (ecrRelatedFailures.length > 0) {
                return {
                    hasECRIssues: true,
                    details: {
                        failureCount: ecrRelatedFailures.length,
                        recentFailures: ecrRelatedFailures.slice(0, 2).map((task) => ({
                            taskArn: task.taskArn?.split('/').pop(),
                            stoppedReason: task.stoppedReason,
                            containerReason: task.containers?.[0]?.reason,
                            lastStatus: task.lastStatus,
                        })),
                        recommendations: [
                            'Verify ECS task execution role has ECR permissions',
                            'Check if ECR repository exists and is accessible',
                            'Ensure image URI is correct and image exists',
                            'Verify AWS region matches ECR repository region',
                        ],
                    },
                };
            }

            return { hasECRIssues: false, details: 'No ECR-related failures detected' };
        } catch (error) {
            return {
                hasECRIssues: false,
                error: error instanceof Error ? error.message : 'Unknown error checking ECR permissions',
            };
        }
    }

    /**
     * Check database connectivity by analyzing application logs and RDS status
     */
    async checkDatabaseConnectivity(): Promise<any> {
        try {
            // Check RDS instance status
            const rdsResponse = await this.rdsClient.send(new DescribeDBInstancesCommand({}));
            const envInstances = (rdsResponse.DBInstances || []).filter(
                (instance) =>
                    instance.DBInstanceIdentifier?.includes(`-${this.environment}-`) ||
                    instance.DBInstanceIdentifier?.includes(`v3-backend-${this.environment}`),
            );

            const dbIssues = [];
            const dbDetails = [];

            for (const instance of envInstances) {
                const isAvailable = instance.DBInstanceStatus === 'available';
                dbDetails.push({
                    identifier: instance.DBInstanceIdentifier,
                    status: instance.DBInstanceStatus,
                    available: isAvailable,
                    endpoint: instance.Endpoint?.Address,
                    port: instance.Endpoint?.Port,
                });

                if (!isAvailable) {
                    dbIssues.push(`Database ${instance.DBInstanceIdentifier} is ${instance.DBInstanceStatus}`);
                }
            }

            // Try to get recent application logs to check for database connection errors
            let logAnalysis: { hasConnectionErrors: boolean; details: string | any } = {
                hasConnectionErrors: false,
                details: 'Could not analyze logs',
            };
            try {
                const logGroups = [
                    `/v3-backend/${this.environment}/api`,
                    `/v3-backend/${this.environment}/background-processor`,
                ];

                for (const logGroupName of logGroups) {
                    try {
                        // Get recent log streams
                        const { logStreams } = await this.cloudwatchLogsClient.send(
                            new DescribeLogStreamsCommand({
                                logGroupName,
                                orderBy: 'LastEventTime',
                                descending: true,
                                limit: 3,
                            }),
                        );

                        if (logStreams && logStreams.length > 0) {
                            // Check the most recent log stream for database errors
                            const recentStream = logStreams[0];
                            const { events } = await this.cloudwatchLogsClient.send(
                                new GetLogEventsCommand({
                                    logGroupName,
                                    logStreamName: recentStream.logStreamName,
                                    startTime: Date.now() - 30 * 60 * 1000, // Last 30 minutes
                                    limit: 50,
                                }),
                            );

                            if (events && events.length > 0) {
                                const dbErrorPatterns = [
                                    'connection refused',
                                    'database connection',
                                    'prisma',
                                    'postgresql',
                                    'database error',
                                    'connection timeout',
                                    'econnrefused',
                                    'database_url',
                                ];

                                const dbErrors = events.filter((event: any) => {
                                    const message = event.message?.toLowerCase() || '';
                                    return dbErrorPatterns.some((pattern) => message.includes(pattern));
                                });

                                if (dbErrors.length > 0) {
                                    logAnalysis = {
                                        hasConnectionErrors: true,
                                        details: {
                                            errorCount: dbErrors.length,
                                            recentErrors: dbErrors.slice(0, 3).map((e: any) => ({
                                                timestamp: new Date(e.timestamp || 0).toISOString(),
                                                message: e.message?.substring(0, 200) + '...',
                                            })),
                                            logGroup: logGroupName,
                                        },
                                    };
                                    break; // Found errors, no need to check other log groups
                                }
                            }
                        }
                    } catch (logError) {
                        // Ignore individual log group errors
                    }
                }
            } catch (logsError) {
                // CloudWatch Logs client not available or other error
            }

            const hasIssues = dbIssues.length > 0 || logAnalysis.hasConnectionErrors;

            const recommendations = [];
            if (dbIssues.length > 0) {
                recommendations.push('Wait for RDS instance to become available');
                recommendations.push('Check RDS instance events for failure details');
            }

            if (logAnalysis.hasConnectionErrors) {
                recommendations.push('Verify DATABASE_URL secret is correct and accessible');
                recommendations.push('Check if database credentials have been rotated');
                recommendations.push('Verify application has network connectivity to RDS instance');
                recommendations.push('Check RDS security group allows connections from ECS tasks');
            }

            if (!hasIssues) {
                recommendations.push('Database appears healthy - check application startup logs for other issues');
            }

            return {
                hasDatabaseIssues: hasIssues,
                details: {
                    databaseInstances: dbDetails,
                    databaseIssues: dbIssues,
                    logAnalysis,
                    recommendations,
                },
            };
        } catch (error) {
            return {
                hasDatabaseIssues: false,
                error: error instanceof Error ? error.message : 'Unknown error checking database connectivity',
            };
        }
    }

    /**
     * Extract primary issue from log analysis results
     */
    private getPrimaryIssueFromLogs(logAnalysis: LogDebugResult[]): string | null {
        for (const result of logAnalysis) {
            if (result.errorPatterns?.length) {
                return result.errorPatterns[0]; // Return the first detected pattern
            }
        }
        return null;
    }

    private getEnhancedDeploymentRecommendations(
        taskFailures: any,
        ecrCheck: any,
        databaseCheck: any,
        logAnalysis?: LogDebugResult[],
    ): string[] {
        const recommendations = [];

        // Log analysis recommendations (highest priority)
        if (logAnalysis?.length) {
            for (const result of logAnalysis) {
                if (result.recommendations?.length) {
                    recommendations.push(...result.recommendations.slice(0, 2)); // Top 2 from each log result
                }
            }
        }

        // ECR-specific recommendations
        if (ecrCheck.hasECRIssues) {
            recommendations.push(...ecrCheck.details.recommendations);
        }

        // Database-specific recommendations
        if (databaseCheck?.hasDatabaseIssues) {
            recommendations.push(...databaseCheck.details.recommendations);
        }

        // Task failure pattern recommendations (fallback)
        if (recommendations.length === 0) {
            if (taskFailures.patterns?.includes('Health check failures')) {
                recommendations.push('Check if application is responding on health endpoint');
                recommendations.push('Verify DATABASE_URL and other secrets are accessible');
                recommendations.push('Check application logs for startup errors');
            }

            if (taskFailures.patterns?.includes('Application crashes (exit code 1)')) {
                recommendations.push('Check application logs for runtime errors');
                recommendations.push('Verify environment variables and secrets');
                recommendations.push('Check for dependency or configuration issues');
            }

            if (taskFailures.patterns?.includes('Out of memory errors')) {
                recommendations.push('Increase memory allocation in task definition');
                recommendations.push('Check for memory leaks in application');
            }

            if (taskFailures.patterns?.includes('Tasks failing to start')) {
                recommendations.push('Check ECS cluster capacity');
                recommendations.push('Verify task definition is valid');
                recommendations.push('Check service and cluster permissions');
            }
        }

        // If still no specific issues found
        if (recommendations.length === 0) {
            recommendations.push('Check CloudWatch logs for more details');
            recommendations.push('Verify application health endpoint');
            recommendations.push('Check task definition for recent changes');
        }

        // Remove duplicates and limit to top 5
        return [...new Set(recommendations)].slice(0, 5);
    }

    /**
     * Enhanced ECS checking with specific diagnostics for common deployment issues
     */
    async check(): Promise<CheckResult> {
        const results: StatusResult[] = [];
        const deploymentIssues: DeploymentIssue[] = [];
        const diagnostics: any = {
            ecrIssues: [],
            healthCheckIssues: [],
            databaseIssues: null,
            logAnalysis: [],
        };

        try {
            const clustersResponse = await this.ecsClient.send(new ListClustersCommand({}));
            const envClusters = (clustersResponse.clusterArns || []).filter(
                (arn) => arn.includes(`-${this.environment}-`) || arn.includes(`v3-backend-${this.environment}`),
            );

            const clusterDetails = await this.ecsClient.send(new DescribeClustersCommand({ clusters: envClusters }));

            // Check database connectivity once for all services
            diagnostics.databaseIssues = await this.checkDatabaseConnectivity();

            for (const cluster of clusterDetails.clusters || []) {
                const clusterName = cluster.clusterName || 'Unknown';
                results.push(
                    this.createResult(
                        `ECS-Cluster-${clusterName}`,
                        'configuration',
                        cluster.status === 'ACTIVE' ? 'healthy' : 'error',
                        `Cluster ${clusterName}: ${cluster.status}`,
                        { status: cluster.status, runningTasks: cluster.runningTasksCount },
                    ),
                );

                // Check services with enhanced diagnostics
                const servicesResponse = await this.ecsClient.send(
                    new ListServicesCommand({ cluster: cluster.clusterArn }),
                );

                if (servicesResponse.serviceArns?.length) {
                    const serviceDetails = await this.ecsClient.send(
                        new DescribeServicesCommand({
                            cluster: cluster.clusterArn,
                            services: servicesResponse.serviceArns,
                        }),
                    );

                    for (const service of serviceDetails.services || []) {
                        const serviceName = service.serviceName || 'Unknown';
                        const running = service.runningCount || 0;
                        const desired = service.desiredCount || 0;
                        const pending = service.pendingCount || 0;

                        let status: StatusResult['status'] = 'healthy';
                        let message = `Service ${serviceName}: ${running}/${desired} tasks running`;

                        if (running < desired || pending > 0) {
                            status = 'warning';
                            if (pending > 0) message += ` (${pending} pending)`;
                        }

                        // Enhanced diagnostics for unhealthy services
                        if (running < desired || pending > 0) {
                            // Check ECR permissions
                            const ecrCheck = await this.checkECRPermissions(cluster.clusterArn!, serviceName);
                            if (ecrCheck.hasECRIssues) {
                                diagnostics.ecrIssues.push({
                                    service: serviceName,
                                    ...ecrCheck.details,
                                });
                            }

                            // Get task failures
                            const taskFailures = await this.getRecentTaskFailures(cluster.clusterArn!, serviceName);

                            // Get detailed logs for unhealthy services
                            let logAnalysis: LogDebugResult[] = [];
                            try {
                                logAnalysis = await this.logDebugger.debugECSServiceLogs({
                                    clusterArn: cluster.clusterArn!,
                                    serviceName: serviceName,
                                    environment: this.environment,
                                    maxLogEvents: 30,
                                    lookbackMinutes: 30,
                                });

                                diagnostics.logAnalysis.push({
                                    service: serviceName,
                                    results: logAnalysis,
                                });
                            } catch (logError) {
                                console.warn(`Failed to get logs for ${serviceName}:`, logError);
                            }

                            // Create comprehensive deployment issue
                            const issue: DeploymentIssue = {
                                service: serviceName,
                                issue: running === 0 ? 'All tasks failing to start' : 'Some tasks failing',
                                details: {
                                    running,
                                    desired,
                                    pending,
                                    taskFailures,
                                    ecrIssues: ecrCheck.hasECRIssues ? ecrCheck.details : null,
                                    databaseIssues: diagnostics.databaseIssues?.hasDatabaseIssues
                                        ? diagnostics.databaseIssues.details
                                        : null,
                                    logAnalysis: logAnalysis.length > 0 ? logAnalysis : null,
                                },
                                recommendations: this.getEnhancedDeploymentRecommendations(
                                    taskFailures,
                                    ecrCheck,
                                    diagnostics.databaseIssues,
                                    logAnalysis,
                                ),
                            };
                            deploymentIssues.push(issue);

                            if (running === 0) {
                                status = 'error';
                                const primaryIssue = ecrCheck.hasECRIssues
                                    ? 'ECR permission issues'
                                    : diagnostics.databaseIssues?.hasDatabaseIssues
                                    ? 'Database connectivity issues'
                                    : this.getPrimaryIssueFromLogs(logAnalysis) ||
                                      taskFailures.summary ||
                                      'Unknown task failures';
                                message = `Service ${serviceName}: ${running}/${desired} tasks running - ${primaryIssue}`;
                            }
                        }

                        results.push(
                            this.createResult(`ECS-Service-${serviceName}`, 'configuration', status, message, {
                                running,
                                desired,
                                pending,
                                deployments: (service.deployments || []).length,
                            }),
                        );
                    }
                }
            }
        } catch (error) {
            results.push(
                this.createResult(
                    'ECS',
                    'critical',
                    'error',
                    `Failed to check ECS: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ),
            );
        }

        return { results, deploymentIssues, diagnostics };
    }
}
