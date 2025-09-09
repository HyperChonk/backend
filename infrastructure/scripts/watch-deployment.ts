#!/usr/bin/env ts-node

import { Command } from 'commander';
import {
    CloudFormationClient,
    DescribeStackEventsCommand,
    DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { normalizeEnvironmentName } from '../config/environments/shared';

interface WatchOptions {
    environment: string;
    region: string;
    stack?: string;
    interval: number;
    showEcs: boolean;
    showAll: boolean;
}

interface StackEvent {
    timestamp: Date;
    resourceType: string;
    resourceStatus: string;
    resourceStatusReason?: string;
    logicalResourceId: string;
    stackName: string;
}

interface ECSDeploymentInfo {
    serviceName: string;
    status: string;
    runningCount: number;
    desiredCount: number;
    rolloutState?: string;
    rolloutStateReason?: string;
    lastEvent?: string;
}

class DeploymentWatcher {
    private cfClient: CloudFormationClient;
    private ecsClient: ECSClient;
    private lastEventTimes: Map<string, Date> = new Map();
    private options: WatchOptions;
    private normalizedEnvironment: string;

    constructor(options: WatchOptions) {
        this.options = options;
        this.normalizedEnvironment = normalizeEnvironmentName(options.environment);
        this.cfClient = new CloudFormationClient({ region: options.region });
        this.ecsClient = new ECSClient({ region: options.region });
    }

    async watch() {
        console.log(`🔍 Watching deployment for ${this.options.environment} environment...`);
        console.log(`📍 Region: ${this.options.region}`);
        console.log(`⏱️  Refresh interval: ${this.options.interval}s`);
        console.log(`🎯 ${this.options.stack ? `Stack: ${this.options.stack}` : 'All stacks'}`);
        console.log('─'.repeat(80));

        while (true) {
            try {
                await this.checkEvents();

                if (this.options.showEcs) {
                    await this.checkECSStatus();
                }

                console.log(`\n🔄 Refreshing in ${this.options.interval}s... (Press Ctrl+C to exit)`);
                await new Promise((resolve) => setTimeout(resolve, this.options.interval * 1000));

                // Clear screen for next iteration
                process.stdout.write('\x1b[2J\x1b[H');
            } catch (error) {
                console.error('❌ Error checking events:', error);
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }

    private async checkEvents() {
        const stacks = this.getStackNames();
        let hasNewEvents = false;

        for (const stackName of stacks) {
            try {
                const events = await this.getStackEvents(stackName);
                const newEvents = this.filterNewEvents(stackName, events);

                if (newEvents.length > 0) {
                    hasNewEvents = true;
                    this.displayEvents(stackName, newEvents);
                }
            } catch (error) {
                // Stack might not exist yet
                if (error instanceof Error && !error.name?.includes('NotFound')) {
                    console.log(`⚠️  Could not check ${stackName}: ${error.message}`);
                }
            }
        }

        if (!hasNewEvents) {
            console.log('📊 No new events. Current stack status:');
            await this.displayStackStatus();
        }
    }

    private async checkECSStatus() {
        const clusterName = `v3-backend-${this.normalizedEnvironment}-cluster`;
        const services = [
            `v3-backend-${this.normalizedEnvironment}-api-service`,
            `v3-backend-${this.normalizedEnvironment}-background-processor-service`,
        ];

        console.log('\n🚀 ECS Services Status:');
        console.log(
            '┌─────────────────────────────────┬─────────────┬─────────────┬─────────────────────────────────┐',
        );
        console.log(
            '│ Service                         │ Status      │ Tasks       │ Deployment                      │',
        );
        console.log(
            '├─────────────────────────────────┼─────────────┼─────────────┼─────────────────────────────────┤',
        );

        for (const serviceName of services) {
            try {
                const response = await this.ecsClient.send(
                    new DescribeServicesCommand({
                        cluster: clusterName,
                        services: [serviceName],
                    }),
                );

                if (response.services?.[0]) {
                    const service = response.services[0];
                    const shortName = serviceName.replace(`v3-backend-${this.normalizedEnvironment}-`, '');
                    const status = service.status || 'Unknown';
                    const tasks = `${service.runningCount}/${service.desiredCount}`;

                    let deploymentInfo = 'Stable';
                    if (service.deployments && service.deployments.length > 0) {
                        const primaryDeployment = service.deployments.find((d) => d.status === 'PRIMARY');
                        if (primaryDeployment?.rolloutState) {
                            deploymentInfo = primaryDeployment.rolloutState;
                            if (primaryDeployment.rolloutStateReason) {
                                deploymentInfo += ` (${primaryDeployment.rolloutStateReason.substring(0, 20)}...)`;
                            }
                        }
                    }

                    const statusIcon = this.getStatusIcon(status);
                    console.log(
                        `│ ${shortName.padEnd(31)} │ ${statusIcon} ${status.padEnd(8)} │ ${tasks.padEnd(
                            11,
                        )} │ ${deploymentInfo.padEnd(31)} │`,
                    );
                }
            } catch (error) {
                const shortName = serviceName.replace(`v3-backend-${this.normalizedEnvironment}-`, '');
                console.log(
                    `│ ${shortName.padEnd(31)} │ ❌ Error    │ -/-         │ Service not found               │`,
                );
            }
        }

        console.log(
            '└─────────────────────────────────┴─────────────┴─────────────┴─────────────────────────────────┘',
        );
    }

    private async displayStackStatus() {
        const stacks = this.getStackNames();

        console.log('┌─────────────────────────────────────────────────┬─────────────────────┬─────────────────────┐');
        console.log('│ Stack                                           │ Status              │ Last Updated        │');
        console.log('├─────────────────────────────────────────────────┼─────────────────────┼─────────────────────┤');

        for (const stackName of stacks) {
            try {
                const response = await this.cfClient.send(new DescribeStacksCommand({ StackName: stackName }));
                const stack = response.Stacks?.[0];

                if (stack) {
                    const status = stack.StackStatus || 'Unknown';
                    const lastUpdated = stack.LastUpdatedTime || stack.CreationTime;
                    const statusIcon = this.getStackStatusIcon(status);
                    const shortName = stackName.replace(`v3-backend-${this.normalizedEnvironment}-`, '');

                    console.log(
                        `│ ${shortName.padEnd(47)} │ ${statusIcon} ${status.padEnd(16)} │ ${lastUpdated
                            ?.toLocaleTimeString()
                            .padEnd(19)} │`,
                    );
                }
            } catch (error) {
                const shortName = stackName.replace(`v3-backend-${this.normalizedEnvironment}-`, '');
                console.log(`│ ${shortName.padEnd(47)} │ ❌ Does not exist  │ -                   │`);
            }
        }

        console.log('└─────────────────────────────────────────────────┴─────────────────────┴─────────────────────┘');
    }

    private getStackNames(): string[] {
        if (this.options.stack) {
            return [this.options.stack];
        }

        const baseStacks = [
            'networking',
            'sqs',
            's3',
            'secrets',
            'database',
            'waf',
            'certificate',
            'compute',
            'log-forwarder',
            'monitoring',
        ];

        return baseStacks.map((stack) => `v3-backend-${this.normalizedEnvironment}-${stack}`);
    }

    private async getStackEvents(stackName: string): Promise<StackEvent[]> {
        const response = await this.cfClient.send(new DescribeStackEventsCommand({ StackName: stackName }));

        return (response.StackEvents || []).map((event) => ({
            timestamp: event.Timestamp!,
            resourceType: event.ResourceType!,
            resourceStatus: event.ResourceStatus!,
            resourceStatusReason: event.ResourceStatusReason,
            logicalResourceId: event.LogicalResourceId!,
            stackName: stackName,
        }));
    }

    private filterNewEvents(stackName: string, events: StackEvent[]): StackEvent[] {
        const lastEventTime = this.lastEventTimes.get(stackName);

        if (!lastEventTime) {
            // First time checking this stack - only show recent events (last 10 minutes)
            const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
            const recentEvents = events.filter((event) => event.timestamp > tenMinutesAgo);

            if (recentEvents.length > 0) {
                this.lastEventTimes.set(stackName, recentEvents[0].timestamp);
            }

            return recentEvents;
        }

        const newEvents = events.filter((event) => event.timestamp > lastEventTime);

        if (newEvents.length > 0) {
            this.lastEventTimes.set(stackName, newEvents[0].timestamp);
        }

        return newEvents;
    }

    private displayEvents(stackName: string, events: StackEvent[]) {
        const shortStackName = stackName.replace(`v3-backend-${this.normalizedEnvironment}-`, '');

        console.log(`\n📋 ${shortStackName.toUpperCase()} Events:`);
        console.log(
            '┌─────────────┬─────────────────────────────────┬─────────────────────┬─────────────────────────────────┐',
        );
        console.log(
            '│ Time        │ Resource                        │ Status              │ Reason                          │',
        );
        console.log(
            '├─────────────┼─────────────────────────────────┼─────────────────────┼─────────────────────────────────┤',
        );

        // Sort events by timestamp (newest first)
        const sortedEvents = events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

        for (const event of sortedEvents.slice(0, 10)) {
            // Show last 10 events
            const time = event.timestamp.toLocaleTimeString();
            const statusIcon = this.getResourceStatusIcon(event.resourceStatus);
            const reason = event.resourceStatusReason?.substring(0, 31) || '-';

            console.log(
                `│ ${time.padEnd(11)} │ ${event.logicalResourceId.padEnd(
                    31,
                )} │ ${statusIcon} ${event.resourceStatus.padEnd(16)} │ ${reason.padEnd(31)} │`,
            );
        }

        console.log(
            '└─────────────┴─────────────────────────────────┴─────────────────────┴─────────────────────────────────┘',
        );
    }

    private getStatusIcon(status: string): string {
        if (status.includes('ACTIVE') || status.includes('RUNNING')) return '🟢';
        if (status.includes('PENDING') || status.includes('UPDATING')) return '🟡';
        if (status.includes('FAILED') || status.includes('STOPPED')) return '🔴';
        return '🟠';
    }

    private getStackStatusIcon(status: string): string {
        if (status.includes('COMPLETE')) return '🟢';
        if (status.includes('IN_PROGRESS')) return '🟡';
        if (status.includes('FAILED')) return '🔴';
        return '🟠';
    }

    private getResourceStatusIcon(status: string): string {
        if (status.includes('COMPLETE')) return '✅';
        if (status.includes('IN_PROGRESS')) return '🔄';
        if (status.includes('FAILED')) return '❌';
        return '⚠️';
    }
}

// CLI setup
const program = new Command();

program
    .name('watch-deployment')
    .description('Watch CloudFormation stack events and ECS deployments in real-time')
    .option('-e, --environment <environment>', 'Environment to watch', 'development')
    .option('-r, --region <region>', 'AWS region', 'us-east-1')
    .option('-s, --stack <stack>', 'Specific stack to watch (optional)')
    .option('-i, --interval <seconds>', 'Refresh interval in seconds', '10')
    .option('--ecs', 'Show ECS service status', false)
    .option('--all', 'Show all events (not just new ones)', false);

program.parse();

const options = program.opts();

async function main() {
    const watchOptions: WatchOptions = {
        environment: options.environment,
        region: options.region,
        stack: options.stack,
        interval: parseInt(options.interval, 10),
        showEcs: options.ecs,
        showAll: options.all,
    };

    const watcher = new DeploymentWatcher(watchOptions);
    await watcher.watch();
}

if (require.main === module) {
    main().catch((error) => {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    });
}

export { DeploymentWatcher };
