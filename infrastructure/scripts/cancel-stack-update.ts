#!/usr/bin/env ts-node

import { Command } from 'commander';
import {
    CloudFormationClient,
    DescribeStacksCommand,
    CancelUpdateStackCommand,
    DescribeStackEventsCommand,
} from '@aws-sdk/client-cloudformation';
import { normalizeEnvironmentName } from '../config/environments/shared';

interface CancelOptions {
    stackName?: string;
    environment?: string;
    region: string;
    force: boolean;
    monitor: boolean;
    quiet: boolean;
}

class StackUpdateCanceller {
    private client: CloudFormationClient;
    private options: CancelOptions;

    constructor(options: CancelOptions) {
        this.options = options;
        this.client = new CloudFormationClient({ region: options.region });
    }

    /**
     * Get stack name from environment if not provided directly
     */
    private getStackName(): string {
        if (this.options.stackName) {
            return this.options.stackName;
        }

        if (!this.options.environment) {
            throw new Error('Either --stack-name or --environment must be provided');
        }

        const normalizedEnv = normalizeEnvironmentName(this.options.environment);
        return `v3-backend-${normalizedEnv}-compute`;
    }

    /**
     * Check current stack status
     */
    private async checkStackStatus(stackName: string): Promise<{ status: string; reason?: string }> {
        try {
            const response = await this.client.send(
                new DescribeStacksCommand({
                    StackName: stackName,
                }),
            );

            const stack = response.Stacks?.[0];
            if (!stack) {
                throw new Error(`Stack ${stackName} not found`);
            }

            return {
                status: stack.StackStatus || 'UNKNOWN',
                reason: stack.StackStatusReason,
            };
        } catch (error) {
            if (error instanceof Error && error.name === 'ValidationError') {
                throw new Error(`Stack ${stackName} not found or access denied`);
            }
            throw error;
        }
    }

    /**
     * Get recent stack events to understand what's stuck
     */
    private async getRecentStackEvents(stackName: string, limit: number = 10): Promise<void> {
        try {
            const response = await this.client.send(
                new DescribeStackEventsCommand({
                    StackName: stackName,
                }),
            );

            const events = response.StackEvents?.slice(0, limit) || [];

            if (events.length === 0) {
                console.log('❌ No recent stack events found');
                return;
            }

            console.log('\n📋 Recent stack events:');
            console.log('─'.repeat(80));

            for (const event of events) {
                const timestamp = event.Timestamp?.toISOString().slice(11, 19) || 'Unknown';
                const resourceType = (event.ResourceType || '').padEnd(25);
                const status = (event.ResourceStatus || '').padEnd(20);
                const reason = event.ResourceStatusReason || '';

                let statusIcon = '●';
                if (status.includes('FAILED')) statusIcon = '❌';
                else if (status.includes('PROGRESS')) statusIcon = '⏳';
                else if (status.includes('COMPLETE')) statusIcon = '✅';

                console.log(`${timestamp} ${statusIcon} ${resourceType} ${status} ${reason}`);
            }
            console.log('─'.repeat(80));
        } catch (error) {
            console.warn(
                '⚠️  Could not retrieve stack events:',
                error instanceof Error ? error.message : 'Unknown error',
            );
        }
    }

    /**
     * Cancel the stack update
     */
    private async cancelUpdate(stackName: string): Promise<void> {
        try {
            await this.client.send(
                new CancelUpdateStackCommand({
                    StackName: stackName,
                }),
            );

            if (!this.options.quiet) {
                console.log(`✅ Successfully initiated cancellation for stack: ${stackName}`);
            }
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('No updates are to be performed')) {
                    throw new Error('No active update operation to cancel');
                } else if (error.message.includes('UPDATE_ROLLBACK_IN_PROGRESS')) {
                    throw new Error('Stack is already rolling back - cancellation not needed');
                } else {
                    throw new Error(`Failed to cancel update: ${error.message}`);
                }
            }
            throw error;
        }
    }

    /**
     * Monitor the cancellation progress
     */
    private async monitorCancellation(stackName: string): Promise<void> {
        if (!this.options.monitor) {
            return;
        }

        console.log('\n⏳ Monitoring cancellation progress...');
        console.log('Press Ctrl+C to stop monitoring (cancellation will continue)\n');

        const startTime = Date.now();
        let previousStatus = '';

        while (true) {
            try {
                const { status, reason } = await this.checkStackStatus(stackName);

                if (status !== previousStatus) {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    console.log(`[${elapsed}s] Stack status: ${status}${reason ? ` - ${reason}` : ''}`);
                    previousStatus = status;
                }

                // Check if cancellation is complete
                if (status.includes('ROLLBACK_COMPLETE') || status.includes('UPDATE_ROLLBACK_COMPLETE')) {
                    console.log('✅ Stack update cancellation completed successfully');
                    break;
                } else if (status.includes('ROLLBACK_FAILED') || status.includes('UPDATE_ROLLBACK_FAILED')) {
                    console.log('❌ Stack update cancellation failed');
                    console.log('💡 You may need to manually fix resources or contact AWS support');
                    break;
                } else if (!status.includes('ROLLBACK') && !status.includes('PROGRESS')) {
                    console.log(`⚠️  Unexpected final status: ${status}`);
                    break;
                }

                // Wait before next check
                await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 seconds
            } catch (error) {
                console.error('❌ Error monitoring stack:', error instanceof Error ? error.message : 'Unknown error');
                break;
            }
        }
    }

    /**
     * Main cancellation workflow
     */
    async cancelStackUpdate(): Promise<void> {
        const stackName = this.getStackName();

        if (!this.options.quiet) {
            console.log(`🔍 Checking stack: ${stackName}`);
        }

        // Check current status
        const { status, reason } = await this.checkStackStatus(stackName);

        if (!this.options.quiet) {
            console.log(`📊 Current status: ${status}${reason ? ` - ${reason}` : ''}`);
        }

        // Show recent events to understand what's stuck
        if (!this.options.quiet) {
            await this.getRecentStackEvents(stackName, 5);
        }

        // Validate that cancellation is appropriate
        if (!status.includes('UPDATE_IN_PROGRESS')) {
            if (status.includes('ROLLBACK')) {
                console.log('ℹ️  Stack is already rolling back - no action needed');
                return;
            } else if (!this.options.force) {
                throw new Error(
                    `Stack is in ${status} state, not UPDATE_IN_PROGRESS. ` +
                        'Use --force to attempt cancellation anyway (not recommended)',
                );
            }
        }

        // Confirm cancellation unless quiet or forced
        if (!this.options.quiet && !this.options.force) {
            console.log('\n⚠️  About to cancel stack update operation.');
            console.log('This will:');
            console.log('  • Stop the current update operation');
            console.log('  • Roll back any changes made during this update');
            console.log('  • Return the stack to its previous state');
            console.log('\nPress Ctrl+C to abort, or Enter to continue...');

            // Simple confirmation (in a real script you might use a proper prompt library)
            await new Promise((resolve) => {
                process.stdin.once('data', () => resolve(undefined));
            });
        }

        // Perform the cancellation
        console.log(`🛑 Cancelling stack update for: ${stackName}`);
        await this.cancelUpdate(stackName);

        // Monitor progress if requested
        await this.monitorCancellation(stackName);

        if (!this.options.quiet) {
            console.log('\n✨ Done! Stack update cancellation has been initiated.');
            console.log('💡 You can check the AWS Console or run this again with --monitor to track progress.');
        }
    }
}

// CLI setup
const program = new Command();

program
    .name('cancel-stack-update')
    .description('Cancel a stuck CloudFormation stack update operation')
    .option('-s, --stack-name <name>', 'Exact stack name to cancel (e.g., v3-backend-development-compute)')
    .option('-e, --environment <env>', 'Environment name (alternative to stack-name)', 'development')
    .option('-r, --region <region>', 'AWS region', 'us-east-1')
    .option('-f, --force', 'Force cancellation even if stack is not in UPDATE_IN_PROGRESS state', false)
    .option('-m, --monitor', 'Monitor the cancellation progress after initiating', false)
    .option('-q, --quiet', 'Suppress non-essential output', false);

program.parse();

const options = program.opts();

const cancellerOptions: CancelOptions = {
    stackName: options.stackName,
    environment: options.environment,
    region: options.region,
    force: options.force,
    monitor: options.monitor,
    quiet: options.quiet,
};

async function main() {
    const canceller = new StackUpdateCanceller(cancellerOptions);

    try {
        await canceller.cancelStackUpdate();
    } catch (error) {
        console.error('❌ Failed to cancel stack update:', error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
    }
}

if (require.main === module) {
    // Handle graceful shutdown during monitoring
    process.on('SIGINT', () => {
        console.log('\n👋 Stopping monitoring (cancellation will continue in background)');
        process.exit(0);
    });

    main();
}

export { StackUpdateCanceller };
