#!/usr/bin/env ts-node

import { Command } from 'commander';
import { ECSClient, DescribeServicesCommand, DescribeTasksCommand, ListTasksCommand } from '@aws-sdk/client-ecs';
import { CloudFormationClient, DescribeStacksCommand, DescribeStackEventsCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { normalizeEnvironmentName } from '../config/environments/shared';
import chalk from 'chalk';

interface DeploymentStatus {
    environment: string;
    timestamp: Date;
    overallStatus: 'HEALTHY' | 'DEPLOYING' | 'FAILED' | 'ROLLBACK_NEEDED';
    services: ServiceStatus[];
    stacks: StackStatus[];
    metrics: HealthMetrics;
    recommendations: string[];
}

interface ServiceStatus {
    name: string;
    status: 'HEALTHY' | 'DEPLOYING' | 'FAILED' | 'DEGRADED';
    runningTasks: number;
    desiredTasks: number;
    deploymentStatus: string;
    lastDeployment: Date | null;
    taskFailures: TaskFailure[];
    rollbackRecommended: boolean;
}

interface StackStatus {
    name: string;
    status: string;
    isStuck: boolean;
    lastUpdate: Date | null;
    rollbackNeeded: boolean;
}

interface TaskFailure {
    taskArn: string;
    exitCode?: number;
    reason?: string;
    stoppedAt?: Date;
}

interface HealthMetrics {
    errorRate: number;
    responseTime: number;
    cpuUtilization: number;
    memoryUtilization: number;
    queueDepth: number;
}

class DeploymentMonitor {
    private ecsClient: ECSClient;
    private cfClient: CloudFormationClient;
    private cwClient: CloudWatchClient;
    private environment: string;
    private region: string;

    constructor(environment: string, region: string = 'us-east-1') {
        this.environment = normalizeEnvironmentName(environment);
        this.region = region;
        this.ecsClient = new ECSClient({ region });
        this.cfClient = new CloudFormationClient({ region });
        this.cwClient = new CloudWatchClient({ region });
    }

    async monitor(): Promise<DeploymentStatus> {
        console.log(chalk.blue(`🔍 Monitoring deployment status for ${this.environment}...`));

        const services = await this.monitorServices();
        const stacks = await this.monitorStacks();
        const metrics = await this.getHealthMetrics();
        
        const overallStatus = this.determineOverallStatus(services, stacks, metrics);
        const recommendations = this.generateRecommendations(services, stacks, metrics, overallStatus);

        return {
            environment: this.environment,
            timestamp: new Date(),
            overallStatus,
            services,
            stacks,
            metrics,
            recommendations,
        };
    }

    private async monitorServices(): Promise<ServiceStatus[]> {
        const services: ServiceStatus[] = [];
        const clusterName = `v3-backend-${this.environment}-cluster`;
        const serviceNames = [
            `v3-backend-${this.environment}-api-service`,
            `v3-backend-${this.environment}-worker-service`,
            `v3-backend-${this.environment}-scheduler-service`,
        ];

        try {
            const response = await this.ecsClient.send(
                new DescribeServicesCommand({
                    cluster: clusterName,
                    services: serviceNames,
                })
            );

            for (const service of response.services || []) {
                const status = await this.analyzeServiceStatus(service, clusterName);
                services.push(status);
            }
        } catch (error) {
            console.error(chalk.red(`Failed to monitor services: ${error}`));
        }

        return services;
    }

    private async analyzeServiceStatus(service: any, clusterName: string): Promise<ServiceStatus> {
        const serviceName = service.serviceName!;
        const runningTasks = service.runningCount || 0;
        const desiredTasks = service.desiredCount || 0;
        
        // Get task failures
        const taskFailures = await this.getRecentTaskFailures(clusterName, serviceName);
        
        // Determine deployment status
        const deployments = service.deployments || [];
        const primaryDeployment = deployments.find((d: any) => d.status === 'PRIMARY');
        const deploymentStatus = primaryDeployment?.rolloutState || 'COMPLETED';
        
        // Determine service status
        let status: 'HEALTHY' | 'DEPLOYING' | 'FAILED' | 'DEGRADED' = 'HEALTHY';
        let rollbackRecommended = false;

        if (runningTasks === 0 && desiredTasks > 0) {
            status = 'FAILED';
            rollbackRecommended = true;
        } else if (runningTasks < desiredTasks) {
            status = 'DEGRADED';
            // Recommend rollback if tasks have been failing for more than 10 minutes
            if (taskFailures.length > 0) {
                const recentFailures = taskFailures.filter(f => 
                    f.stoppedAt && (Date.now() - f.stoppedAt.getTime()) < 10 * 60 * 1000
                );
                if (recentFailures.length >= 3) {
                    rollbackRecommended = true;
                }
            }
        } else if (deploymentStatus === 'IN_PROGRESS') {
            status = 'DEPLOYING';
        } else if (deploymentStatus === 'FAILED') {
            status = 'FAILED';
            rollbackRecommended = true;
        }

        return {
            name: serviceName,
            status,
            runningTasks,
            desiredTasks,
            deploymentStatus,
            lastDeployment: primaryDeployment?.updatedAt || null,
            taskFailures,
            rollbackRecommended,
        };
    }

    private async getRecentTaskFailures(clusterName: string, serviceName: string): Promise<TaskFailure[]> {
        const failures: TaskFailure[] = [];

        try {
            const tasksResponse = await this.ecsClient.send(
                new ListTasksCommand({
                    cluster: clusterName,
                    serviceName,
                    desiredStatus: 'STOPPED',
                    maxResults: 10,
                })
            );

            if (tasksResponse.taskArns && tasksResponse.taskArns.length > 0) {
                const taskDetails = await this.ecsClient.send(
                    new DescribeTasksCommand({
                        cluster: clusterName,
                        tasks: tasksResponse.taskArns,
                    })
                );

                for (const task of taskDetails.tasks || []) {
                    if (task.lastStatus === 'STOPPED' && task.stoppedReason) {
                        failures.push({
                            taskArn: task.taskArn!,
                            exitCode: task.containers?.[0]?.exitCode,
                            reason: task.stoppedReason,
                            stoppedAt: task.stoppedAt,
                        });
                    }
                }
            }
        } catch (error) {
            // Non-critical error
        }

        return failures;
    }

    private async monitorStacks(): Promise<StackStatus[]> {
        const stacks: StackStatus[] = [];
        const stackNames = [
            `v3-backend-${this.environment}-networking`,
            `v3-backend-${this.environment}-database`,
            `v3-backend-${this.environment}-compute`,
            `v3-backend-${this.environment}-monitoring`,
        ];

        for (const stackName of stackNames) {
            try {
                const response = await this.cfClient.send(
                    new DescribeStacksCommand({ StackName: stackName })
                );

                const stack = response.Stacks?.[0];
                if (stack) {
                    const status = stack.StackStatus!;
                    const lastUpdate = stack.LastUpdatedTime || stack.CreationTime;
                    const isStuck = this.isStackStuck(status, lastUpdate);
                    const rollbackNeeded = status.includes('FAILED') || 
                                         status.includes('ROLLBACK_FAILED') ||
                                         isStuck;

                    stacks.push({
                        name: stackName,
                        status,
                        isStuck,
                        lastUpdate: lastUpdate || null,
                        rollbackNeeded,
                    });
                }
            } catch (error) {
                stacks.push({
                    name: stackName,
                    status: 'NOT_FOUND',
                    isStuck: false,
                    lastUpdate: null,
                    rollbackNeeded: true,
                });
            }
        }

        return stacks;
    }

    private isStackStuck(status: string, lastUpdate?: Date): boolean {
        if (!status.includes('IN_PROGRESS')) return false;
        if (!lastUpdate) return true;

        const minutesAgo = (Date.now() - lastUpdate.getTime()) / (1000 * 60);
        
        // Different timeouts for different operations
        if (status.includes('DELETE')) return minutesAgo > 45;
        if (status.includes('CLEANUP')) return minutesAgo > 10;
        return minutesAgo > 30;
    }

    private async getHealthMetrics(): Promise<HealthMetrics> {
        // Placeholder for actual metric collection
        // In real implementation, collect from CloudWatch
        return {
            errorRate: 0,
            responseTime: 0,
            cpuUtilization: 0,
            memoryUtilization: 0,
            queueDepth: 0,
        };
    }

    private determineOverallStatus(
        services: ServiceStatus[],
        stacks: StackStatus[],
        metrics: HealthMetrics
    ): 'HEALTHY' | 'DEPLOYING' | 'FAILED' | 'ROLLBACK_NEEDED' {
        // Check for critical failures
        const failedServices = services.filter(s => s.status === 'FAILED');
        const failedStacks = stacks.filter(s => s.rollbackNeeded);
        
        if (failedServices.length > 0 || failedStacks.length > 0) {
            return 'ROLLBACK_NEEDED';
        }

        // Check for degraded services
        const degradedServices = services.filter(s => s.status === 'DEGRADED');
        const servicesRecommendingRollback = services.filter(s => s.rollbackRecommended);
        
        if (servicesRecommendingRollback.length > 0) {
            return 'ROLLBACK_NEEDED';
        }

        // Check for ongoing deployments
        const deployingServices = services.filter(s => s.status === 'DEPLOYING');
        const busyStacks = stacks.filter(s => s.status.includes('IN_PROGRESS'));
        
        if (deployingServices.length > 0 || busyStacks.length > 0) {
            return 'DEPLOYING';
        }

        // Check metrics thresholds
        if (metrics.errorRate > 5 || metrics.responseTime > 5000) {
            return 'ROLLBACK_NEEDED';
        }

        if (degradedServices.length > 0) {
            return 'FAILED';
        }

        return 'HEALTHY';
    }

    private generateRecommendations(
        services: ServiceStatus[],
        stacks: StackStatus[],
        metrics: HealthMetrics,
        overallStatus: string
    ): string[] {
        const recommendations: string[] = [];

        if (overallStatus === 'ROLLBACK_NEEDED') {
            recommendations.push('🚨 IMMEDIATE ACTION REQUIRED: Rollback deployment');
            
            const failedServices = services.filter(s => s.status === 'FAILED' || s.rollbackRecommended);
            for (const service of failedServices) {
                recommendations.push(`• Rollback ${service.name} to previous task definition`);
            }

            const failedStacks = stacks.filter(s => s.rollbackNeeded);
            for (const stack of failedStacks) {
                recommendations.push(`• Fix stuck stack: ${stack.name} (${stack.status})`);
            }
        } else if (overallStatus === 'FAILED') {
            recommendations.push('⚠️ DEGRADED PERFORMANCE: Monitor and consider rollback');
            
            const degradedServices = services.filter(s => s.status === 'DEGRADED');
            for (const service of degradedServices) {
                recommendations.push(`• Monitor ${service.name}: ${service.runningTasks}/${service.desiredTasks} tasks`);
            }
        } else if (overallStatus === 'DEPLOYING') {
            recommendations.push('🔄 DEPLOYMENT IN PROGRESS: Continue monitoring');
            
            const deployingServices = services.filter(s => s.status === 'DEPLOYING');
            for (const service of deployingServices) {
                recommendations.push(`• Monitor ${service.name} deployment progress`);
            }
        } else {
            recommendations.push('✅ ENVIRONMENT HEALTHY: All systems operational');
        }

        // Add specific recommendations based on failures
        for (const service of services) {
            if (service.taskFailures.length > 0) {
                const recentFailures = service.taskFailures.slice(0, 3);
                for (const failure of recentFailures) {
                    if (failure.reason?.includes('HealthCheckGracePeriod')) {
                        recommendations.push(`• Increase health check grace period for ${service.name}`);
                    } else if (failure.reason?.includes('OutOfMemory')) {
                        recommendations.push(`• Increase memory allocation for ${service.name}`);
                    } else if (failure.exitCode === 1) {
                        recommendations.push(`• Check application logs for ${service.name} startup errors`);
                    }
                }
            }
        }

        return recommendations;
    }

    formatReport(status: DeploymentStatus): void {
        console.log(chalk.blue('\n📊 DEPLOYMENT MONITORING REPORT'));
        console.log(chalk.blue('═'.repeat(60)));
        
        const statusIcon = {
            'HEALTHY': '✅',
            'DEPLOYING': '🔄',
            'FAILED': '⚠️',
            'ROLLBACK_NEEDED': '🚨'
        };

        const statusColor = {
            'HEALTHY': chalk.green,
            'DEPLOYING': chalk.yellow,
            'FAILED': chalk.yellow,
            'ROLLBACK_NEEDED': chalk.red
        };

        console.log(`Environment: ${status.environment}`);
        console.log(`Status: ${statusIcon[status.overallStatus]} ${statusColor[status.overallStatus](status.overallStatus)}`);
        console.log(`Timestamp: ${status.timestamp.toISOString()}`);

        // Services status
        console.log(chalk.blue('\n🛠️ SERVICES STATUS:'));
        for (const service of status.services) {
            const icon = service.status === 'HEALTHY' ? '✅' : 
                        service.status === 'DEPLOYING' ? '🔄' : 
                        service.status === 'DEGRADED' ? '⚠️' : '❌';
            
            console.log(`${icon} ${service.name}: ${service.runningTasks}/${service.desiredTasks} tasks (${service.status})`);
            
            if (service.rollbackRecommended) {
                console.log(chalk.red(`   🚨 ROLLBACK RECOMMENDED`));
            }
            
            if (service.taskFailures.length > 0) {
                console.log(chalk.yellow(`   Recent failures: ${service.taskFailures.length}`));
                for (const failure of service.taskFailures.slice(0, 2)) {
                    console.log(chalk.gray(`     • ${failure.reason} (Exit: ${failure.exitCode})`));
                }
            }
        }

        // Stacks status
        console.log(chalk.blue('\n🏗️ INFRASTRUCTURE STATUS:'));
        for (const stack of status.stacks) {
            const icon = stack.rollbackNeeded ? '❌' : 
                        stack.status.includes('IN_PROGRESS') ? '🔄' : '✅';
            
            console.log(`${icon} ${stack.name}: ${stack.status}`);
            
            if (stack.isStuck) {
                console.log(chalk.red(`   🚨 STACK APPEARS STUCK`));
            }
        }

        // Recommendations
        console.log(chalk.blue('\n💡 RECOMMENDATIONS:'));
        for (let i = 0; i < status.recommendations.length; i++) {
            console.log(`${i + 1}. ${status.recommendations[i]}`);
        }

        // Next steps based on status
        console.log(chalk.blue('\n🚀 NEXT STEPS:'));
        if (status.overallStatus === 'ROLLBACK_NEEDED') {
            console.log(chalk.red('1. Execute immediate rollback: npm run rollback:' + status.environment));
            console.log(chalk.red('2. Investigate failure causes before next deployment'));
            console.log(chalk.red('3. Run pre-deployment validation: npm run validate:' + status.environment));
        } else if (status.overallStatus === 'DEPLOYING') {
            console.log(chalk.yellow('1. Continue monitoring: npm run monitor:' + status.environment));
            console.log(chalk.yellow('2. Check logs if deployment takes too long: npm run logs:' + status.environment));
        } else if (status.overallStatus === 'FAILED') {
            console.log(chalk.yellow('1. Monitor for auto-recovery: npm run monitor:' + status.environment));
            console.log(chalk.yellow('2. Consider manual intervention if issues persist'));
        } else {
            console.log(chalk.green('1. Deployment successful - monitor for stability'));
            console.log(chalk.green('2. Run health checks: npm run health-check:' + status.environment));
        }
    }

    async continuousMonitor(intervalSeconds: number = 30, maxDuration: number = 1800): Promise<void> {
        const startTime = Date.now();
        console.log(chalk.blue(`🔄 Starting continuous monitoring (${intervalSeconds}s intervals, ${maxDuration/60}min max)`));
        
        while (Date.now() - startTime < maxDuration * 1000) {
            const status = await this.monitor();
            this.formatReport(status);
            
            if (status.overallStatus === 'HEALTHY') {
                console.log(chalk.green('\n✅ Deployment successful - monitoring complete'));
                break;
            } else if (status.overallStatus === 'ROLLBACK_NEEDED') {
                console.log(chalk.red('\n🚨 Critical issues detected - monitoring stopped'));
                process.exit(1);
            }
            
            console.log(chalk.gray(`\n⏳ Waiting ${intervalSeconds} seconds for next check...`));
            await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
        }
    }
}

// CLI setup
const program = new Command();

program
    .name('deployment-monitor')
    .description('Monitor deployment status and recommend actions')
    .option('-e, --env <environment>', 'Environment to monitor', 'development')
    .option('-r, --region <region>', 'AWS region', 'us-east-1')
    .option('-c, --continuous', 'Continuous monitoring mode', false)
    .option('-i, --interval <seconds>', 'Monitoring interval in seconds', '30')
    .option('-d, --duration <seconds>', 'Maximum monitoring duration in seconds', '1800')
    .option('-j, --json', 'Output JSON format', false);

program.parse();

const options = program.opts();

async function main() {
    try {
        const monitor = new DeploymentMonitor(options.env, options.region);
        
        if (options.continuous) {
            await monitor.continuousMonitor(
                parseInt(options.interval),
                parseInt(options.duration)
            );
        } else {
            const status = await monitor.monitor();
            
            if (options.json) {
                console.log(JSON.stringify(status, null, 2));
            } else {
                monitor.formatReport(status);
            }
            
            // Exit with appropriate code
            const exitCode = status.overallStatus === 'ROLLBACK_NEEDED' ? 1 :
                            status.overallStatus === 'FAILED' ? 2 : 0;
            process.exit(exitCode);
        }
    } catch (error) {
        console.error(
            chalk.red('❌ Monitoring failed:'),
            error instanceof Error ? error.message : 'Unknown error'
        );
        process.exit(3);
    }
}

if (require.main === module) {
    main();
}