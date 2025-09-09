#!/usr/bin/env ts-node

import { Command } from 'commander';
import { AWSStatusChecker } from './status-checker/aws-status-checker';
import { FullStatus, StatusResult } from './status-checker/types';
import { CloudFormationClient, DescribeStacksCommand, StackStatus } from '@aws-sdk/client-cloudformation';
import { ECSClient, DescribeServicesCommand, DescribeClustersCommand } from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { normalizeEnvironmentName } from '../config/environments/shared';

type ExtendedStackStatus = StackStatus | 'DOES_NOT_EXIST';

interface StackInfo {
    name: string;
    status: ExtendedStackStatus;
    lastUpdated: Date;
    driftStatus?: string;
}

interface ServiceInfo {
    name: string;
    type: 'ECS' | 'RDS' | 'Lambda' | 'LoadBalancer';
    status: string;
    details: string;
    lastUpdated?: Date;
}

interface DashboardData {
    stacks: StackInfo[];
    services: ServiceInfo[];
    summary: {
        totalStacks: number;
        healthyStacks: number;
        totalServices: number;
        healthyServices: number;
    };
    infraStatus: FullStatus;
}

class InfrastructureDashboard {
    private region: string;
    private environment: string;
    private normalizedEnvironment: string;
    private debugUnknownStatuses: boolean;
    private cfClient: CloudFormationClient;
    private ecsClient: ECSClient;
    private rdsClient: RDSClient;
    private lambdaClient: LambdaClient;

    constructor(region: string = 'us-east-1', environment: string = 'development', debug: boolean = false) {
        this.region = region;
        this.environment = environment;
        this.normalizedEnvironment = normalizeEnvironmentName(environment);
        this.debugUnknownStatuses = debug;
        this.cfClient = new CloudFormationClient({ region });
        this.ecsClient = new ECSClient({ region });
        this.rdsClient = new RDSClient({ region });
        this.lambdaClient = new LambdaClient({ region });
    }

    async gatherData(): Promise<DashboardData> {
        console.log(`🔍 Gathering infrastructure data for ${this.environment} environment...\n`);

        // Get comprehensive status from existing checker
        const statusChecker = new AWSStatusChecker(this.region, this.environment);
        const infraStatus = await statusChecker.checkAll();

        // Get detailed stack information
        const stacks = await this.getStackDetails();

        // Get detailed service information
        const services = await this.getServiceDetails();

        const summary = {
            totalStacks: stacks.length,
            healthyStacks: stacks.filter((s) => this.getStackStatusIcon(s.status) === '🟢').length,
            totalServices: services.length,
            healthyServices: services.filter((s) => this.getServiceStatusIcon(s.status) === '🟢').length,
        };

        return {
            stacks,
            services,
            summary,
            infraStatus,
        };
    }

    private async getStackDetails(): Promise<StackInfo[]> {
        const stacks: StackInfo[] = [];

        const stackNames = [
            `v3-backend-${this.normalizedEnvironment}-networking`,
            `v3-backend-${this.normalizedEnvironment}-sqs`,
            `v3-backend-${this.normalizedEnvironment}-s3`,
            `v3-backend-${this.normalizedEnvironment}-secrets`,
            `v3-backend-${this.normalizedEnvironment}-database`,
            `v3-backend-${this.normalizedEnvironment}-waf`,
            `v3-backend-${this.normalizedEnvironment}-certificate`,
            `v3-backend-${this.normalizedEnvironment}-compute`,
            `v3-backend-${this.normalizedEnvironment}-log-forwarder`,
            `v3-backend-${this.normalizedEnvironment}-monitoring`,
        ];

        for (const stackName of stackNames) {
            try {
                const response = await this.cfClient.send(new DescribeStacksCommand({ StackName: stackName }));

                if (response.Stacks && response.Stacks[0]) {
                    const stack = response.Stacks[0];
                    stacks.push({
                        name: stackName,
                        status: stack.StackStatus as ExtendedStackStatus,
                        lastUpdated: stack.LastUpdatedTime || stack.CreationTime || new Date(),
                        driftStatus: stack.DriftInformation?.StackDriftStatus,
                    });
                }
            } catch (error) {
                stacks.push({
                    name: stackName,
                    status: 'DOES_NOT_EXIST' as ExtendedStackStatus,
                    lastUpdated: new Date(0),
                });
            }
        }

        return stacks;
    }

    private async getServiceDetails(): Promise<ServiceInfo[]> {
        const services: ServiceInfo[] = [];

        // Get ECS services
        try {
            const clusterName = `v3-backend-${this.normalizedEnvironment}-cluster`;
            const serviceNames = [
                `v3-backend-${this.normalizedEnvironment}-api-service`,
                `v3-backend-${this.normalizedEnvironment}-background-processor-service`,
            ];

            for (const serviceName of serviceNames) {
                try {
                    const response = await this.ecsClient.send(
                        new DescribeServicesCommand({
                            cluster: clusterName,
                            services: [serviceName],
                        }),
                    );

                    if (response.services && response.services[0]) {
                        const service = response.services[0];
                        let status = service.status || 'Unknown';
                        let details = `${service.runningCount}/${service.desiredCount} tasks`;

                        // Add more context for service status
                        if (service.deployments && service.deployments.length > 0) {
                            const primaryDeployment = service.deployments.find((d) => d.status === 'PRIMARY');
                            if (primaryDeployment) {
                                if (primaryDeployment.rolloutState) {
                                    details += ` (${primaryDeployment.rolloutState})`;
                                }
                                if (primaryDeployment.rolloutStateReason) {
                                    details += ` - ${primaryDeployment.rolloutStateReason}`;
                                }
                            }
                        }

                        // Check for service events that might indicate issues
                        if (service.events && service.events.length > 0) {
                            const recentEvent = service.events[0]; // Most recent event
                            if (recentEvent.message && recentEvent.message.includes('error')) {
                                status = 'Error';
                                details += ` - ${recentEvent.message.substring(0, 50)}`;
                            }
                        }

                        services.push({
                            name: serviceName.replace(`v3-backend-${this.normalizedEnvironment}-`, ''),
                            type: 'ECS',
                            status: status,
                            details: details,
                            lastUpdated: service.createdAt,
                        });
                    }
                } catch (error) {
                    services.push({
                        name: serviceName.replace(`v3-backend-${this.normalizedEnvironment}-`, ''),
                        type: 'ECS',
                        status: 'Not Found',
                        details: 'Service does not exist',
                    });
                }
            }
        } catch (error) {
            // Cluster doesn't exist
        }

        // Get RDS instances
        try {
            const response = await this.rdsClient.send(new DescribeDBInstancesCommand({}));
            if (response.DBInstances) {
                for (const db of response.DBInstances) {
                    if (db.DBInstanceIdentifier?.includes(this.normalizedEnvironment)) {
                        services.push({
                            name: db.DBInstanceIdentifier.replace(`v3-backend-${this.normalizedEnvironment}-`, ''),
                            type: 'RDS',
                            status: db.DBInstanceStatus || 'Unknown',
                            details: `${db.DBInstanceClass} (${db.Engine})`,
                            lastUpdated: db.InstanceCreateTime,
                        });
                    }
                }
            }
        } catch (error) {
            // RDS access issues
        }

        // Get Lambda functions
        try {
            const response = await this.lambdaClient.send(new ListFunctionsCommand({}));
            if (response.Functions) {
                for (const func of response.Functions) {
                    if (func.FunctionName?.includes(this.normalizedEnvironment)) {
                        // Get more detailed status information
                        let status = 'Unknown';
                        let details = `${func.Runtime} (${func.MemorySize}MB)`;

                        // Determine actual status from multiple fields
                        if (func.State) {
                            status = func.State;

                            // Add state reason if available for more context
                            if (func.StateReason) {
                                details += ` - ${func.StateReason}`;
                            }
                        } else if (func.LastUpdateStatus) {
                            // Fallback to LastUpdateStatus if State is not available
                            status = func.LastUpdateStatus;

                            if (func.LastUpdateStatusReason) {
                                details += ` - ${func.LastUpdateStatusReason}`;
                            }
                        } else {
                            // If function exists in the list, it's at least created
                            status = 'Active';
                        }

                        // Debug logging for unknown statuses
                        if (
                            (status === 'Unknown' || status.toLowerCase().includes('unknown')) &&
                            this.debugUnknownStatuses
                        ) {
                            console.error(`🔍 DEBUG - Lambda function ${func.FunctionName}:`);
                            console.error(`   State: ${func.State}`);
                            console.error(`   StateReason: ${func.StateReason}`);
                            console.error(`   LastUpdateStatus: ${func.LastUpdateStatus}`);
                            console.error(`   LastUpdateStatusReason: ${func.LastUpdateStatusReason}`);
                            console.error(`   Raw function data:`, JSON.stringify(func, null, 2));
                        }

                        // Add code size info if available
                        if (func.CodeSize) {
                            details = `${func.Runtime} (${func.MemorySize}MB, ${Math.round(func.CodeSize / 1024)}KB)`;
                        }

                        services.push({
                            name: func.FunctionName.replace(`v3-backend-${this.normalizedEnvironment}-`, ''),
                            type: 'Lambda',
                            status: status,
                            details: details,
                            lastUpdated: new Date(func.LastModified || ''),
                        });
                    }
                }
            }
        } catch (error) {
            // Lambda access issues
        }

        return services;
    }

    displayDashboard(data: DashboardData) {
        console.clear();
        console.log('🏗️  INFRASTRUCTURE DASHBOARD\n');
        console.log(`Environment: ${this.environment.toUpperCase()}`);
        console.log(`Region: ${this.region}`);
        console.log(`Timestamp: ${new Date().toLocaleString()}\n`);

        // Overall Health Status
        this.displayOverallHealth(data.infraStatus);

        // Summary Cards
        this.displaySummary(data.summary);

        // Stacks Table
        this.displayStacksTable(data.stacks);

        // Services Table
        this.displayServicesTable(data.services);

        // Issues and Recommendations
        this.displayIssues(data.infraStatus);
    }

    private displayOverallHealth(status: FullStatus) {
        const healthIcon =
            status.overallHealth.operational === 'healthy'
                ? '🟢'
                : status.overallHealth.operational === 'degraded'
                ? '🟡'
                : '🔴';

        console.log(`${healthIcon} OVERALL HEALTH: ${status.overallHealth.operational.toUpperCase()}`);
        console.log(`   System Functional: ${status.overallHealth.systemFunctional ? '✅' : '❌'}`);
        console.log(`   Critical Issues: ${status.overallHealth.criticalIssues}\n`);
    }

    private displaySummary(summary: any) {
        console.log('📊 SUMMARY');
        console.log('┌─────────────────┬───────┬─────────┐');
        console.log('│ Category        │ Total │ Healthy │');
        console.log('├─────────────────┼───────┼─────────┤');
        console.log(
            `│ Stacks          │   ${summary.totalStacks.toString().padStart(3)}   │    ${summary.healthyStacks
                .toString()
                .padStart(3)}   │`,
        );
        console.log(
            `│ Services        │   ${summary.totalServices.toString().padStart(3)}   │    ${summary.healthyServices
                .toString()
                .padStart(3)}   │`,
        );
        console.log('└─────────────────┴───────┴─────────┘\n');
    }

    private displayStacksTable(stacks: StackInfo[]) {
        console.log('📦 CLOUDFORMATION STACKS');
        console.log('┌──────────────────────────┬──────────────────────┬─────────────────────┐');
        console.log('│ Stack Name               │ Status               │ Last Updated        │');
        console.log('├──────────────────────────┼──────────────────────┼─────────────────────┤');

        stacks.forEach((stack) => {
            const shortName = stack.name.replace(`v3-backend-${this.normalizedEnvironment}-`, '');
            const statusIcon = this.getStackStatusIcon(stack.status);
            const lastUpdated = stack.lastUpdated.getTime() === 0 ? 'Never' : stack.lastUpdated.toLocaleDateString();

            console.log(
                `│ ${shortName.padEnd(24)} │ ${statusIcon} ${stack.status.padEnd(17)} │ ${lastUpdated.padEnd(19)} │`,
            );
        });

        console.log('└──────────────────────────┴──────────────────────┴─────────────────────┘\n');
    }

    private displayServicesTable(services: ServiceInfo[]) {
        console.log('⚙️  SERVICES');
        console.log(
            '┌─────────────────────────────────┬────────┬──────────────────┬──────────────────────────────────────────────┐',
        );
        console.log(
            '│ Service Name                    │ Type   │ Status           │ Details                                      │',
        );
        console.log(
            '├─────────────────────────────────┼────────┼──────────────────┼──────────────────────────────────────────────┤',
        );

        services.forEach((service) => {
            const statusIcon = this.getServiceStatusIcon(service.status);

            // Smart truncation for service names - show start and end for very long names
            let truncatedName: string;
            if (service.name.length > 31) {
                if (service.name.length > 50) {
                    // For very long names, show start...end
                    truncatedName =
                        service.name.substring(0, 12) + '...' + service.name.substring(service.name.length - 16);
                } else {
                    // For moderately long names, just truncate end
                    truncatedName = service.name.substring(0, 28) + '...';
                }
            } else {
                truncatedName = service.name;
            }

            // Smart truncation for details - preserve key information
            let truncatedDetails: string;
            if (service.details.length > 44) {
                // For ECS services, try to preserve task count
                if (service.type === 'ECS' && service.details.includes('tasks')) {
                    const taskInfo = service.details.match(/\d+\/\d+ tasks/);
                    if (taskInfo) {
                        const statusInfo = service.details.match(/\(([^)]+)\)/);
                        if (statusInfo) {
                            truncatedDetails = `${taskInfo[0]} (${statusInfo[1]})`;
                        } else {
                            truncatedDetails = taskInfo[0] + '...';
                        }
                    } else {
                        truncatedDetails = service.details.substring(0, 41) + '...';
                    }
                } else {
                    truncatedDetails = service.details.substring(0, 41) + '...';
                }
            } else {
                truncatedDetails = service.details;
            }

            // Final safety check - ensure details fit in column
            if (truncatedDetails.length > 44) {
                truncatedDetails = truncatedDetails.substring(0, 41) + '...';
            }

            console.log(
                `│ ${truncatedName.padEnd(31)} │ ${service.type.padEnd(6)} │ ${statusIcon} ${service.status.padEnd(
                    13,
                )} │ ${truncatedDetails.padEnd(44)} │`,
            );
        });

        console.log(
            '└─────────────────────────────────┴────────┴──────────────────┴──────────────────────────────────────────────┘\n',
        );
    }

    private displayIssues(status: FullStatus) {
        const issues = status.services.filter((s) => s.status === 'error' || s.status === 'warning');

        if (issues.length > 0) {
            console.log('⚠️  ISSUES & RECOMMENDATIONS');
            console.log('┌──────────────────────────────────────────────────────────────────────────┐');

            issues.forEach((issue) => {
                const icon = issue.status === 'error' ? '🔴' : '🟡';
                console.log(`│ ${icon} ${issue.service.padEnd(25)} │ ${issue.message.substring(0, 40).padEnd(40)} │`);
            });

            console.log('└──────────────────────────────────────────────────────────────────────────┘\n');
        }

        if (status.deploymentIssues && status.deploymentIssues.length > 0) {
            console.log('🚨 DEPLOYMENT ISSUES');
            status.deploymentIssues.forEach((issue) => {
                console.log(`   • ${issue.service}: ${issue.issue}`);
                issue.recommendations.forEach((rec) => {
                    console.log(`     → ${rec}`);
                });
            });
            console.log('');
        }
    }

    private getStackStatusIcon(status: ExtendedStackStatus): string {
        switch (status) {
            case 'CREATE_COMPLETE':
            case 'UPDATE_COMPLETE':
            case 'UPDATE_ROLLBACK_COMPLETE':
                return '🟢';
            case 'CREATE_IN_PROGRESS':
            case 'UPDATE_IN_PROGRESS':
            case 'UPDATE_ROLLBACK_IN_PROGRESS':
                return '🟡';
            case 'CREATE_FAILED':
            case 'UPDATE_FAILED':
            case 'ROLLBACK_FAILED':
                return '🔴';
            case 'DOES_NOT_EXIST':
                return '⚫';
            default:
                return '��';
        }
    }

    private getServiceStatusIcon(status: string): string {
        switch (status.toLowerCase()) {
            // Healthy/Active states
            case 'active':
            case 'running':
            case 'available':
            case 'successful':
                return '🟢';
            // In-progress/transitional states
            case 'pending':
            case 'updating':
            case 'in_progress':
            case 'inprogress':
                return '🟡';
            // Error/failed states
            case 'failed':
            case 'stopped':
            case 'not found':
            case 'error':
            case 'inactive':
                return '🔴';
            // Unknown/unclear states
            case 'unknown':
                return '🟠';
            default:
                // For any other status, try to determine by common patterns
                if (status.toLowerCase().includes('error') || status.toLowerCase().includes('fail')) {
                    return '🔴';
                } else if (status.toLowerCase().includes('progress') || status.toLowerCase().includes('pending')) {
                    return '🟡';
                } else if (
                    status.toLowerCase().includes('active') ||
                    status.toLowerCase().includes('complete') ||
                    status.toLowerCase().includes('successful')
                ) {
                    return '🟢';
                } else {
                    return '🟠';
                }
        }
    }
}

// CLI setup
const program = new Command();

program
    .name('infrastructure-dashboard')
    .description('Display infrastructure status dashboard')
    .option('-e, --env <environment>', 'Environment to check', 'development')
    .option('-r, --region <region>', 'AWS region', 'us-east-1')
    .option('-w, --watch', 'Watch mode - refresh every 30 seconds')
    .option('-j, --json', 'Output raw JSON data')
    .option('-d, --debug', 'Show debug information for unknown statuses');

program.parse();

const options = program.opts();

async function main() {
    const dashboard = new InfrastructureDashboard(options.region, options.env, options.debug);

    if (options.watch) {
        // Watch mode
        while (true) {
            try {
                const data = await dashboard.gatherData();
                if (options.json) {
                    console.log(JSON.stringify(data, null, 2));
                } else {
                    dashboard.displayDashboard(data);
                }
                console.log('🔄 Refreshing in 30 seconds... (Press Ctrl+C to exit)');
                await new Promise((resolve) => setTimeout(resolve, 30000));
            } catch (error) {
                console.error('❌ Error gathering data:', error);
                await new Promise((resolve) => setTimeout(resolve, 10000));
            }
        }
    } else {
        // Single run
        try {
            const data = await dashboard.gatherData();
            if (options.json) {
                console.log(JSON.stringify(data, null, 2));
            } else {
                dashboard.displayDashboard(data);
            }
        } catch (error) {
            console.error('❌ Failed to generate dashboard:', error);
            process.exit(1);
        }
    }
}

if (require.main === module) {
    main();
}

export { InfrastructureDashboard };
