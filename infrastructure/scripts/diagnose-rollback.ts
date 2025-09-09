#!/usr/bin/env ts-node

import { Command } from 'commander';
import {
    CloudFormationClient,
    DescribeStacksCommand,
    DescribeStackEventsCommand,
    StackEvent,
} from '@aws-sdk/client-cloudformation';
import {
    ECSClient,
    DescribeServicesCommand,
    DescribeTasksCommand,
    ListTasksCommand,
    DescribeTaskDefinitionCommand,
    DescribeContainerInstancesCommand,
    DescribeClustersCommand,
    Task,
    Service,
    TaskDefinition,
} from '@aws-sdk/client-ecs';
import {
    CloudWatchLogsClient,
    FilterLogEventsCommand,
    DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { normalizeEnvironmentName } from '../config/environments/shared';
import chalk from 'chalk';

interface RollbackAnalysis {
    environment: string;
    services: ServiceAnalysis[];
    stackEvents: StackEventAnalysis[];
    deploymentHistory: DeploymentEvent[];
    circuitBreakerEvents: CircuitBreakerEvent[];
    summary: DiagnosticSummary;
}

interface ServiceAnalysis {
    serviceName: string;
    cluster: string;
    status: string;
    runningTasks: number;
    desiredTasks: number;
    taskDefinition: string;
    lastDeployment: Date | null;
    deploymentRollbackReason?: string;
    platformVersion: string;
    createdAt: Date;
    updatedAt: Date;
    deployments: ECSDeployment[];
    taskFailures: TaskFailure[];
    isRolledBack: boolean;
    originalTaskDefinition?: string;
}

interface ECSDeployment {
    id: string;
    status: string;
    taskDefinition: string;
    desiredCount: number;
    runningCount: number;
    pendingCount: number;
    createdAt: Date;
    updatedAt: Date;
    rolloutState?: string;
    rolloutStateReason?: string;
}

interface TaskFailure {
    taskArn: string;
    lastStatus: string;
    exitCode?: number;
    exitReason?: string;
    stoppedAt?: Date;
    stoppedReason?: string;
    logEvents: string[];
}

interface StackEventAnalysis {
    stackName: string;
    eventTime: Date;
    eventType: string;
    resourceType: string;
    resourceStatus: string;
    resourceStatusReason?: string;
    logicalResourceId: string;
    physicalResourceId?: string;
}

interface DeploymentEvent {
    timestamp: Date;
    source: 'CloudFormation' | 'ECS' | 'TaskDefinition';
    event: string;
    details: string;
    severity: 'INFO' | 'WARNING' | 'ERROR';
}

interface CircuitBreakerEvent {
    serviceName: string;
    timestamp: Date;
    event: 'ROLLBACK_INITIATED' | 'ROLLBACK_COMPLETED' | 'DEPLOYMENT_FAILED';
    reason: string;
    taskDefinitionFrom?: string;
    taskDefinitionTo?: string;
}

interface DiagnosticSummary {
    totalServices: number;
    healthyServices: number;
    rolledBackServices: number;
    failedServices: number;
    lastSuccessfulDeployment: Date | null;
    lastFailedDeployment: Date | null;
    primaryIssue?: string;
    recommendedActions: string[];
}

class RollbackDiagnostic {
    private cfClient: CloudFormationClient;
    private ecsClient: ECSClient;
    private logsClient: CloudWatchLogsClient;
    private environment: string;
    private region: string;

    constructor(environment: string, region: string = 'us-east-1') {
        this.environment = normalizeEnvironmentName(environment);
        this.region = region;
        this.cfClient = new CloudFormationClient({ region });
        this.ecsClient = new ECSClient({ region });
        this.logsClient = new CloudWatchLogsClient({ region });
    }

    async diagnose(): Promise<RollbackAnalysis> {
        console.log(chalk.blue(`🔍 Analyzing rollback situation for ${this.environment} environment...`));

        const services = await this.analyzeServices();
        const stackEvents = await this.analyzeStackEvents();
        const deploymentHistory = await this.buildDeploymentHistory(services, stackEvents);
        const circuitBreakerEvents = await this.analyzeCircuitBreakerEvents(services);
        const summary = this.buildSummary(services, deploymentHistory, circuitBreakerEvents);

        return {
            environment: this.environment,
            services,
            stackEvents,
            deploymentHistory,
            circuitBreakerEvents,
            summary,
        };
    }

    private async analyzeServices(): Promise<ServiceAnalysis[]> {
        const clusterName = `v3-backend-${this.environment}-cluster`;
        const serviceNames = [
            `v3-backend-${this.environment}-api-service`,
            `v3-backend-${this.environment}-worker-service`,
            `v3-backend-${this.environment}-scheduler-service`,
        ];

        const services: ServiceAnalysis[] = [];

        try {
            const servicesResponse = await this.ecsClient.send(
                new DescribeServicesCommand({
                    cluster: clusterName,
                    services: serviceNames,
                }),
            );

            for (const service of servicesResponse.services || []) {
                const analysis = await this.analyzeService(service);
                services.push(analysis);
            }
        } catch (error) {
            console.error(chalk.red(`❌ Failed to analyze services: ${error}`));
        }

        return services;
    }

    private async analyzeService(service: Service): Promise<ServiceAnalysis> {
        const serviceName = service.serviceName!;
        const cluster = service.clusterArn!;

        // Get task failures
        const taskFailures = await this.getTaskFailures(cluster, serviceName);

        // Analyze deployments
        const deployments: ECSDeployment[] = (service.deployments || []).map((dep) => ({
            id: dep.id!,
            status: dep.status!,
            taskDefinition: dep.taskDefinition!,
            desiredCount: dep.desiredCount || 0,
            runningCount: dep.runningCount || 0,
            pendingCount: dep.pendingCount || 0,
            createdAt: dep.createdAt!,
            updatedAt: dep.updatedAt!,
            rolloutState: dep.rolloutState,
            rolloutStateReason: dep.rolloutStateReason,
        }));

        // Check if service is rolled back
        const isRolledBack = await this.isServiceRolledBack(serviceName, service.taskDefinition!);

        return {
            serviceName,
            cluster,
            status: service.status!,
            runningTasks: service.runningCount || 0,
            desiredTasks: service.desiredCount || 0,
            taskDefinition: service.taskDefinition!,
            lastDeployment: service.deployments?.[0]?.updatedAt || null,
            deploymentRollbackReason: deployments.find((d) => d.rolloutState === 'FAILED')?.rolloutStateReason,
            platformVersion: service.platformVersion || 'LATEST',
            createdAt: service.createdAt!,
            updatedAt: service.deployments?.[0]?.updatedAt || service.createdAt!,
            deployments,
            taskFailures,
            isRolledBack,
        };
    }

    private async getTaskFailures(cluster: string, serviceName: string): Promise<TaskFailure[]> {
        const failures: TaskFailure[] = [];

        try {
            const tasksResponse = await this.ecsClient.send(
                new ListTasksCommand({
                    cluster,
                    serviceName,
                    desiredStatus: 'STOPPED',
                    maxResults: 10,
                }),
            );

            if (tasksResponse.taskArns && tasksResponse.taskArns.length > 0) {
                const taskDetails = await this.ecsClient.send(
                    new DescribeTasksCommand({
                        cluster,
                        tasks: tasksResponse.taskArns,
                    }),
                );

                for (const task of taskDetails.tasks || []) {
                    if (task.lastStatus === 'STOPPED' && task.stoppedReason) {
                        const logEvents = await this.getTaskLogEvents(task);
                        failures.push({
                            taskArn: task.taskArn!,
                            lastStatus: task.lastStatus!,
                            exitCode: task.containers?.[0]?.exitCode,
                            exitReason: task.containers?.[0]?.reason,
                            stoppedAt: task.stoppedAt,
                            stoppedReason: task.stoppedReason,
                            logEvents,
                        });
                    }
                }
            }
        } catch (error) {
            console.warn(chalk.yellow(`⚠️  Failed to get task failures for ${serviceName}: ${error}`));
        }

        return failures;
    }

    private async getTaskLogEvents(task: Task): Promise<string[]> {
        const logEvents: string[] = [];

        try {
            const logGroupName = `/v3-backend/${this.environment}/api`; // Default to API logs
            const logStreamName = `api/${task.taskArn?.split('/').pop()}`;

            const logsResponse = await this.logsClient.send(
                new FilterLogEventsCommand({
                    logGroupName,
                    logStreamNames: [logStreamName],
                    limit: 10,
                    startTime: task.createdAt ? task.createdAt.getTime() : undefined,
                    endTime: task.stoppedAt ? task.stoppedAt.getTime() : undefined,
                }),
            );

            logEvents.push(...(logsResponse.events || []).map((e) => e.message || ''));
        } catch (error) {
            // Log errors are not critical
        }

        return logEvents;
    }

    private async isServiceRolledBack(serviceName: string, currentTaskDefinition: string): Promise<boolean> {
        // Check if the current task definition is significantly older than recent deployments
        try {
            const taskDefResponse = await this.ecsClient.send(
                new DescribeTaskDefinitionCommand({
                    taskDefinition: currentTaskDefinition,
                }),
            );

            const taskDefAge = Date.now() - (taskDefResponse.taskDefinition?.registeredAt?.getTime() || 0);
            const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;

            return taskDefAge > sevenDaysInMs;
        } catch (error) {
            return false;
        }
    }

    private async analyzeStackEvents(): Promise<StackEventAnalysis[]> {
        const stackNames = [
            `v3-backend-${this.environment}-compute`,
            `v3-backend-${this.environment}-database`,
            `v3-backend-${this.environment}-monitoring`,
        ];

        const events: StackEventAnalysis[] = [];

        for (const stackName of stackNames) {
            try {
                const eventsResponse = await this.cfClient.send(
                    new DescribeStackEventsCommand({
                        StackName: stackName,
                    }),
                );

                const recentEvents = (eventsResponse.StackEvents || [])
                    .filter((event) => {
                        const eventTime = event.Timestamp?.getTime() || 0;
                        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
                        return eventTime > oneDayAgo;
                    })
                    .map((event) => ({
                        stackName,
                        eventTime: event.Timestamp!,
                        eventType: event.ClientRequestToken || 'Unknown',
                        resourceType: event.ResourceType!,
                        resourceStatus: event.ResourceStatus!,
                        resourceStatusReason: event.ResourceStatusReason,
                        logicalResourceId: event.LogicalResourceId!,
                        physicalResourceId: event.PhysicalResourceId,
                    }));

                events.push(...recentEvents);
            } catch (error) {
                console.warn(chalk.yellow(`⚠️  Failed to get stack events for ${stackName}: ${error}`));
            }
        }

        return events.sort((a, b) => b.eventTime.getTime() - a.eventTime.getTime());
    }

    private async buildDeploymentHistory(
        services: ServiceAnalysis[],
        stackEvents: StackEventAnalysis[],
    ): Promise<DeploymentEvent[]> {
        const events: DeploymentEvent[] = [];

        // Add stack events
        for (const event of stackEvents) {
            let severity: 'INFO' | 'WARNING' | 'ERROR' = 'INFO';
            if (event.resourceStatus.includes('FAILED')) {
                severity = 'ERROR';
            } else if (event.resourceStatus.includes('ROLLBACK')) {
                severity = 'WARNING';
            }

            events.push({
                timestamp: event.eventTime,
                source: 'CloudFormation',
                event: event.resourceStatus,
                details: `${event.resourceType} ${event.logicalResourceId}: ${event.resourceStatusReason || ''}`,
                severity,
            });
        }

        // Add service deployment events
        for (const service of services) {
            for (const deployment of service.deployments) {
                let severity: 'INFO' | 'WARNING' | 'ERROR' = 'INFO';
                if (deployment.status === 'FAILED') {
                    severity = 'ERROR';
                } else if (deployment.rolloutState === 'FAILED') {
                    severity = 'ERROR';
                }

                events.push({
                    timestamp: deployment.updatedAt,
                    source: 'ECS',
                    event: `Deployment ${deployment.status}`,
                    details: `${service.serviceName}: ${deployment.rolloutStateReason || 'No details'}`,
                    severity,
                });
            }
        }

        return events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    private async analyzeCircuitBreakerEvents(services: ServiceAnalysis[]): Promise<CircuitBreakerEvent[]> {
        const events: CircuitBreakerEvent[] = [];

        for (const service of services) {
            // Look for rollback indicators in deployments
            const failedDeployments = service.deployments.filter(
                (d) => d.status === 'FAILED' || d.rolloutState === 'FAILED',
            );

            for (const deployment of failedDeployments) {
                if (
                    deployment.rolloutStateReason?.includes('circuit breaker') ||
                    deployment.rolloutStateReason?.includes('rollback')
                ) {
                    events.push({
                        serviceName: service.serviceName,
                        timestamp: deployment.updatedAt,
                        event: 'ROLLBACK_INITIATED',
                        reason: deployment.rolloutStateReason || 'Circuit breaker triggered',
                        taskDefinitionTo: deployment.taskDefinition,
                    });
                }
            }

            // Check if service is currently in a rolled-back state
            if (service.isRolledBack) {
                events.push({
                    serviceName: service.serviceName,
                    timestamp: service.updatedAt,
                    event: 'ROLLBACK_COMPLETED',
                    reason: 'Service is running an older task definition',
                    taskDefinitionTo: service.taskDefinition,
                });
            }
        }

        return events;
    }

    private buildSummary(
        services: ServiceAnalysis[],
        deploymentHistory: DeploymentEvent[],
        circuitBreakerEvents: CircuitBreakerEvent[],
    ): DiagnosticSummary {
        const totalServices = services.length;
        const healthyServices = services.filter((s) => s.runningTasks === s.desiredTasks).length;
        const rolledBackServices = services.filter((s) => s.isRolledBack).length;
        const failedServices = services.filter((s) => s.runningTasks === 0).length;

        const lastSuccessfulDeployment =
            deploymentHistory
                .filter((e) => e.severity === 'INFO' && e.event.includes('SUCCESS'))
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]?.timestamp || null;

        const lastFailedDeployment =
            deploymentHistory
                .filter((e) => e.severity === 'ERROR')
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]?.timestamp || null;

        const recommendedActions: string[] = [];
        let primaryIssue = 'Services are healthy';

        if (failedServices > 0) {
            primaryIssue = `${failedServices} service(s) are completely down`;
            recommendedActions.push('Check task failure logs for startup errors');
            recommendedActions.push('Verify secrets and configuration are correct');
        } else if (rolledBackServices > 0) {
            primaryIssue = `${rolledBackServices} service(s) have been rolled back`;
            recommendedActions.push('Check recent deployment logs for failure reasons');
            recommendedActions.push('Verify new task definitions are healthy');
            recommendedActions.push('Consider manually triggering a new deployment');
        }

        if (circuitBreakerEvents.length > 0) {
            recommendedActions.push('Review circuit breaker events for deployment failures');
        }

        return {
            totalServices,
            healthyServices,
            rolledBackServices,
            failedServices,
            lastSuccessfulDeployment,
            lastFailedDeployment,
            primaryIssue,
            recommendedActions,
        };
    }

    formatReport(analysis: RollbackAnalysis): void {
        console.log(chalk.blue('\n📊 ROLLBACK DIAGNOSTIC REPORT'));
        console.log(chalk.blue('═'.repeat(50)));

        // Summary
        console.log(chalk.green('\n🎯 SUMMARY'));
        console.log(`Environment: ${analysis.environment}`);
        console.log(`Total Services: ${analysis.summary.totalServices}`);
        console.log(`Healthy Services: ${analysis.summary.healthyServices}`);
        console.log(`Rolled Back Services: ${analysis.summary.rolledBackServices}`);
        console.log(`Failed Services: ${analysis.summary.failedServices}`);
        console.log(`Primary Issue: ${analysis.summary.primaryIssue}`);

        if (analysis.summary.lastSuccessfulDeployment) {
            console.log(`Last Successful Deployment: ${analysis.summary.lastSuccessfulDeployment.toLocaleString()}`);
        }
        if (analysis.summary.lastFailedDeployment) {
            console.log(`Last Failed Deployment: ${analysis.summary.lastFailedDeployment.toLocaleString()}`);
        }

        // Services
        console.log(chalk.green('\n🔧 SERVICES ANALYSIS'));
        for (const service of analysis.services) {
            const status = service.runningTasks === service.desiredTasks ? '✅' : '❌';
            const rollbackStatus = service.isRolledBack ? '🔄 ROLLED BACK' : '✅ CURRENT';

            console.log(`${status} ${service.serviceName}: ${service.runningTasks}/${service.desiredTasks} tasks`);
            console.log(`   Status: ${rollbackStatus}`);
            console.log(`   Task Definition: ${service.taskDefinition}`);
            console.log(`   Last Updated: ${service.updatedAt.toLocaleString()}`);

            if (service.deploymentRollbackReason) {
                console.log(`   Rollback Reason: ${service.deploymentRollbackReason}`);
            }

            if (service.taskFailures.length > 0) {
                console.log(`   Recent Task Failures: ${service.taskFailures.length}`);
                for (const failure of service.taskFailures.slice(0, 3)) {
                    console.log(`     - ${failure.stoppedReason} (Exit Code: ${failure.exitCode})`);
                }
            }
        }

        // Circuit Breaker Events
        if (analysis.circuitBreakerEvents.length > 0) {
            console.log(chalk.yellow('\n⚡ CIRCUIT BREAKER EVENTS'));
            for (const event of analysis.circuitBreakerEvents) {
                console.log(`${event.timestamp.toLocaleString()} - ${event.serviceName}: ${event.event}`);
                console.log(`   Reason: ${event.reason}`);
            }
        }

        // Recent Deployment History
        console.log(chalk.green('\n📈 RECENT DEPLOYMENT HISTORY'));
        const recentEvents = analysis.deploymentHistory.slice(0, 10);
        for (const event of recentEvents) {
            const icon = event.severity === 'ERROR' ? '❌' : event.severity === 'WARNING' ? '⚠️' : '✅';
            console.log(`${icon} ${event.timestamp.toLocaleString()} - ${event.source}: ${event.event}`);
            console.log(`   ${event.details}`);
        }

        // Recommendations
        console.log(chalk.green('\n💡 RECOMMENDED ACTIONS'));
        for (let i = 0; i < analysis.summary.recommendedActions.length; i++) {
            console.log(`${i + 1}. ${analysis.summary.recommendedActions[i]}`);
        }

        // Next Steps
        console.log(chalk.blue('\n🚀 IMMEDIATE NEXT STEPS'));
        console.log('1. Run service health check: npm run check-status:dev');
        console.log('2. Check application logs: npm run logs:dev');
        console.log(
            '3. Review CloudFormation events: aws cloudformation describe-stack-events --stack-name v3-backend-development-compute',
        );
        console.log('4. If needed, trigger new deployment: Run your deployment pipeline');
    }
}

// CLI setup
const program = new Command();

program
    .name('diagnose-rollback')
    .description('Diagnose ECS service rollback issues')
    .option('-e, --env <environment>', 'Environment to diagnose', 'development')
    .option('-r, --region <region>', 'AWS region', 'us-east-1')
    .option('-j, --json', 'Output JSON format')
    .option('-s, --summary', 'Show summary only');

program.parse();

const options = program.opts();

async function main() {
    try {
        const diagnostic = new RollbackDiagnostic(options.env, options.region);
        const analysis = await diagnostic.diagnose();

        if (options.json) {
            console.log(JSON.stringify(analysis, null, 2));
        } else if (options.summary) {
            console.log(JSON.stringify(analysis.summary, null, 2));
        } else {
            diagnostic.formatReport(analysis);
        }
    } catch (error) {
        console.error(
            chalk.red('❌ Failed to diagnose rollback:'),
            error instanceof Error ? error.message : 'Unknown error',
        );
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
