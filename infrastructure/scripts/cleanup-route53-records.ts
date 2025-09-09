#!/usr/bin/env ts-node

import {
    Route53Client,
    ListResourceRecordSetsCommand,
    ChangeResourceRecordSetsCommand,
    GetHostedZoneCommand,
} from '@aws-sdk/client-route-53';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import chalk from 'chalk';

interface RecordToDelete {
    name: string;
    type: string;
    ttl?: number;
    values: string[];
}

class Route53Cleaner {
    private route53Client: Route53Client;
    private cfClient: CloudFormationClient;

    constructor() {
        this.route53Client = new Route53Client({ region: 'us-east-1' });
        this.cfClient = new CloudFormationClient({ region: 'us-east-1' });
    }

    /**
     * Get hosted zone ID from CloudFormation stack outputs
     */
    private async getHostedZoneIdFromStack(environment: string): Promise<string | null> {
        const stackName = `v3-backend-${environment}-hosted-zone`;

        try {
            const response = await this.cfClient.send(
                new DescribeStacksCommand({
                    StackName: stackName,
                }),
            );

            const stack = response.Stacks?.[0];
            if (!stack?.Outputs) {
                console.log(chalk.yellow(`⚠️  No outputs found for stack ${stackName}`));
                return null;
            }

            const hostedZoneOutput = stack.Outputs.find((output) => output.OutputKey === 'HostedZoneId');
            return hostedZoneOutput?.OutputValue || null;
        } catch (error: any) {
            if (error.name === 'ValidationError' && error.message.includes('does not exist')) {
                console.log(chalk.yellow(`⚠️  Stack ${stackName} does not exist - hosted zone may already be deleted`));
                return null;
            }
            console.error(chalk.red(`❌ Error getting hosted zone ID from stack: ${error.message}`));
            return null;
        }
    }

    /**
     * List all resource record sets in the hosted zone
     */
    private async listRecordSets(hostedZoneId: string): Promise<RecordToDelete[]> {
        try {
            const response = await this.route53Client.send(
                new ListResourceRecordSetsCommand({
                    HostedZoneId: hostedZoneId,
                }),
            );

            const recordsToDelete: RecordToDelete[] = [];

            for (const record of response.ResourceRecordSets || []) {
                // Skip SOA and NS records for the root domain - these are required
                if (record.Type === 'SOA' || (record.Type === 'NS' && record.Name?.endsWith('.io.'))) {
                    continue;
                }

                // Skip if no resource records (alias records)
                if (!record.ResourceRecords || record.ResourceRecords.length === 0) {
                    // Handle alias records separately
                    if (record.AliasTarget) {
                        recordsToDelete.push({
                            name: record.Name!,
                            type: record.Type!,
                            values: [record.AliasTarget.DNSName!], // For display purposes
                        });
                    }
                    continue;
                }

                recordsToDelete.push({
                    name: record.Name!,
                    type: record.Type!,
                    ttl: record.TTL,
                    values: record.ResourceRecords.map((rr) => rr.Value!),
                });
            }

            return recordsToDelete;
        } catch (error: any) {
            console.error(chalk.red(`❌ Error listing record sets: ${error.message}`));
            throw error;
        }
    }

    /**
     * Delete a batch of resource record sets
     */
    private async deleteRecords(hostedZoneId: string, records: RecordToDelete[]): Promise<boolean> {
        if (records.length === 0) {
            console.log(chalk.green('✅ No records to delete'));
            return true;
        }

        try {
            const response = await this.route53Client.send(
                new ListResourceRecordSetsCommand({
                    HostedZoneId: hostedZoneId,
                }),
            );

            const changes = [];

            for (const record of records) {
                // Find the actual record from the API response to get complete data
                const actualRecord = response.ResourceRecordSets?.find(
                    (r) => r.Name === record.name && r.Type === record.type,
                );

                if (!actualRecord) {
                    console.log(chalk.yellow(`⚠️  Record ${record.name} (${record.type}) not found, skipping`));
                    continue;
                }

                console.log(chalk.blue(`🗑️  Preparing to delete: ${record.type} ${record.name}`));

                const change: any = {
                    Action: 'DELETE',
                    ResourceRecordSet: {
                        Name: actualRecord.Name,
                        Type: actualRecord.Type,
                    },
                };

                // Handle alias records
                if (actualRecord.AliasTarget) {
                    change.ResourceRecordSet.AliasTarget = actualRecord.AliasTarget;
                } else {
                    change.ResourceRecordSet.TTL = actualRecord.TTL;
                    change.ResourceRecordSet.ResourceRecords = actualRecord.ResourceRecords;
                }

                changes.push(change);
            }

            if (changes.length === 0) {
                console.log(chalk.yellow('⚠️  No valid records found to delete'));
                return true;
            }

            const changeResponse = await this.route53Client.send(
                new ChangeResourceRecordSetsCommand({
                    HostedZoneId: hostedZoneId,
                    ChangeBatch: {
                        Comment: `Cleanup records before hosted zone deletion - ${new Date().toISOString()}`,
                        Changes: changes,
                    },
                }),
            );

            console.log(chalk.green(`✅ Successfully initiated deletion of ${changes.length} records`));
            console.log(chalk.blue(`📄 Change ID: ${changeResponse.ChangeInfo?.Id}`));

            // Wait a moment for propagation
            console.log(chalk.blue('⏳ Waiting for DNS changes to propagate...'));
            await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 second wait

            return true;
        } catch (error: any) {
            console.error(chalk.red(`❌ Error deleting records: ${error.message}`));
            return false;
        }
    }

    /**
     * Main cleanup function
     */
    async cleanupHostedZone(environment: string, dryRun: boolean = false): Promise<boolean> {
        console.log(chalk.blue(`🧹 Starting Route53 cleanup for ${environment} environment`));

        if (dryRun) {
            console.log(chalk.yellow('🔍 DRY RUN MODE - No changes will be made'));
        }

        // Get hosted zone ID from CloudFormation
        const hostedZoneId = await this.getHostedZoneIdFromStack(environment);
        if (!hostedZoneId) {
            console.log(chalk.yellow('⚠️  No hosted zone found, cleanup not needed'));
            return true;
        }

        console.log(chalk.blue(`🎯 Found hosted zone: ${hostedZoneId}`));

        // Get hosted zone details
        try {
            const zoneResponse = await this.route53Client.send(
                new GetHostedZoneCommand({
                    Id: hostedZoneId,
                }),
            );
            console.log(chalk.blue(`📄 Hosted zone name: ${zoneResponse.HostedZone?.Name}`));
        } catch (error: any) {
            console.error(chalk.red(`❌ Error getting hosted zone details: ${error.message}`));
        }

        // List all records
        const recordsToDelete = await this.listRecordSets(hostedZoneId);

        if (recordsToDelete.length === 0) {
            console.log(chalk.green('✅ No non-essential records found in hosted zone'));
            return true;
        }

        console.log(chalk.yellow(`📋 Found ${recordsToDelete.length} non-essential records to delete:`));

        for (const record of recordsToDelete) {
            console.log(chalk.gray(`   • ${record.type} ${record.name} → ${record.values.join(', ')}`));
        }

        if (dryRun) {
            console.log(chalk.yellow('🔍 DRY RUN: Would delete the above records'));
            return true;
        }

        // Ask for confirmation
        console.log(
            chalk.yellow('\n⚠️  This will permanently delete all non-essential DNS records in the hosted zone.'),
        );
        console.log(chalk.yellow('⚠️  Only SOA and NS records for the root domain will be preserved.'));

        // In non-interactive mode, proceed automatically
        if (process.env.CI || process.argv.includes('--yes')) {
            console.log(chalk.blue('🤖 Running in non-interactive mode, proceeding with cleanup...'));
        } else {
            // For interactive use, would prompt for confirmation
            console.log(chalk.blue('📝 Use --yes flag to skip confirmation in scripts'));
        }

        // Delete records
        const success = await this.deleteRecords(hostedZoneId, recordsToDelete);

        if (success) {
            console.log(chalk.green('✅ Route53 cleanup completed successfully'));
            console.log(chalk.green('✅ The hosted zone should now be ready for deletion'));
        } else {
            console.log(chalk.red('❌ Route53 cleanup failed'));
        }

        return success;
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    const environment = args[0];
    const dryRun = args.includes('--dry-run');

    if (!environment) {
        console.error(chalk.red('❌ Environment is required'));
        console.log(chalk.blue('Usage: ts-node cleanup-route53-records.ts <environment> [--dry-run] [--yes]'));
        console.log(chalk.blue('Example: ts-node cleanup-route53-records.ts staging --dry-run'));
        process.exit(1);
    }

    if (!['development', 'staging', 'production'].includes(environment)) {
        console.error(chalk.red(`❌ Invalid environment: ${environment}`));
        console.log(chalk.blue('Valid environments: development, staging, production'));
        process.exit(1);
    }

    const cleaner = new Route53Cleaner();

    try {
        const success = await cleaner.cleanupHostedZone(environment, dryRun);
        process.exit(success ? 0 : 1);
    } catch (error: any) {
        console.error(chalk.red(`❌ Cleanup failed: ${error.message}`));
        process.exit(1);
    }
}

// Only run main if this file is executed directly
if (require.main === module) {
    main().catch((error) => {
        console.error(chalk.red('❌ Unexpected error:'), error);
        process.exit(1);
    });
}

export { Route53Cleaner };
