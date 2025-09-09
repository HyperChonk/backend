#!/usr/bin/env ts-node

import {
    CloudFormationClient,
    DescribeStacksCommand,
    DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import {
    CloudWatchLogsClient,
    DescribeLogGroupsCommand,
    DescribeSubscriptionFiltersCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { LambdaClient, GetFunctionCommand } from '@aws-sdk/client-lambda';
import { Command } from 'commander';
import { normalizeEnvironmentName } from '../config/environments/shared';

interface LogGroupInfo {
    name: string;
    exists: boolean;
    creationTime?: Date;
    subscriptionFilters: SubscriptionFilterInfo[];
}

interface SubscriptionFilterInfo {
    filterName: string;
    destinationArn: string;
    filterPattern: string;
}

interface StackResourceInfo {
    logicalId: string;
    physicalId: string;
    resourceType: string;
    status: string;
}

interface LambdaInfo {
    functionName: string;
    exists: boolean;
    state?: string;
    lastModified?: string;
    arn?: string;
}

interface DebugReport {
    environment: string;
    region: string;
    timestamp: Date;
    expectedLogGroups: LogGroupInfo[];
    actualLogGroups: string[];
    computeStackResources: StackResourceInfo[];
    logForwarderStackResources: StackResourceInfo[];
    computeStackOutputs: any[];
    logForwarderStackOutputs: any[];
    lambdaFunction: LambdaInfo;
    issues: string[];
    recommendations: string[];
}

class LogForwardingDebugger {
    private cfClient: CloudFormationClient;
    private logsClient: CloudWatchLogsClient;
    private lambdaClient: LambdaClient;
    private environment: string;
    private normalizedEnvironment: string;
    private region: string;

    constructor(region: string = 'us-east-1', environment: string = 'development') {
        this.region = region;
        this.environment = environment;
        this.normalizedEnvironment = normalizeEnvironmentName(environment);
        this.cfClient = new CloudFormationClient({ region });
        this.logsClient = new CloudWatchLogsClient({ region });
        this.lambdaClient = new LambdaClient({ region });
    }

    async debug(): Promise<DebugReport> {
        console.log(`🔍 Debugging log forwarding for ${this.environment} environment in ${this.region}\n`);

        const report: DebugReport = {
            environment: this.environment,
            region: this.region,
            timestamp: new Date(),
            expectedLogGroups: [],
            actualLogGroups: [],
            computeStackResources: [],
            logForwarderStackResources: [],
            computeStackOutputs: [],
            logForwarderStackOutputs: [],
            lambdaFunction: { functionName: '', exists: false },
            issues: [],
            recommendations: [],
        };

        // Step 1: Check expected log groups
        console.log('📋 Step 1: Checking expected log groups...');
        report.expectedLogGroups = await this.checkExpectedLogGroups();

        // Step 2: Discover all actual log groups
        console.log('📋 Step 2: Discovering actual log groups...');
        report.actualLogGroups = await this.discoverActualLogGroups();

        // Step 3: Check compute stack resources
        console.log('📋 Step 3: Checking compute stack resources...');
        report.computeStackResources = await this.checkStackResources(
            `v3-backend-${this.normalizedEnvironment}-compute`,
        );
        report.computeStackOutputs = await this.checkStackOutputs(`v3-backend-${this.normalizedEnvironment}-compute`);

        // Step 4: Check log-forwarder stack resources
        console.log('📋 Step 4: Checking log-forwarder stack resources...');
        report.logForwarderStackResources = await this.checkStackResources(
            `v3-backend-${this.normalizedEnvironment}-log-forwarder`,
        );
        report.logForwarderStackOutputs = await this.checkStackOutputs(
            `v3-backend-${this.normalizedEnvironment}-log-forwarder`,
        );

        // Step 5: Check Lambda function
        console.log('📋 Step 5: Checking Lambda function...');
        report.lambdaFunction = await this.checkLambdaFunction();

        // Analyze and generate issues/recommendations
        this.analyzeReport(report);

        return report;
    }

    private async checkExpectedLogGroups(): Promise<LogGroupInfo[]> {
        const expectedLogGroups = [
            // Application logs (custom log groups created by compute stack)
            `/v3-backend/${this.normalizedEnvironment}/api`,
            `/v3-backend/${this.normalizedEnvironment}/background-processor`,
            `/v3-backend/${this.normalizedEnvironment}/migration`,
            // Infrastructure logs
            `/v3-backend/${this.normalizedEnvironment}/waf`,
            `/aws/vpc/flowlogs/${this.normalizedEnvironment}`,
            // Note: /aws/ecs/... log groups are NOT expected since we use custom log groups
        ];

        const logGroupsInfo: LogGroupInfo[] = [];

        for (const logGroupName of expectedLogGroups) {
            try {
                const response = await this.logsClient.send(
                    new DescribeLogGroupsCommand({
                        logGroupNamePrefix: logGroupName,
                        limit: 1,
                    }),
                );

                const exists =
                    response.logGroups &&
                    response.logGroups.length > 0 &&
                    response.logGroups.some((lg) => lg.logGroupName === logGroupName);

                const logGroup = response.logGroups?.find((lg) => lg.logGroupName === logGroupName);

                // Check subscription filters for this log group
                let subscriptionFilters: SubscriptionFilterInfo[] = [];
                if (exists) {
                    try {
                        const filtersResponse = await this.logsClient.send(
                            new DescribeSubscriptionFiltersCommand({
                                logGroupName: logGroupName,
                            }),
                        );

                        subscriptionFilters =
                            filtersResponse.subscriptionFilters?.map((filter) => ({
                                filterName: filter.filterName || '',
                                destinationArn: filter.destinationArn || '',
                                filterPattern: filter.filterPattern || '',
                            })) || [];
                    } catch (error) {
                        // Ignore subscription filter errors for now
                    }
                }

                logGroupsInfo.push({
                    name: logGroupName,
                    exists: exists || false,
                    creationTime: logGroup?.creationTime ? new Date(logGroup.creationTime) : undefined,
                    subscriptionFilters,
                });

                console.log(
                    `   ${exists ? '✅' : '❌'} ${logGroupName} - ${subscriptionFilters.length} subscription filters`,
                );
            } catch (error) {
                logGroupsInfo.push({
                    name: logGroupName,
                    exists: false,
                    subscriptionFilters: [],
                });
                console.log(`   ❌ ${logGroupName} - Error checking: ${error}`);
            }
        }

        return logGroupsInfo;
    }

    private async discoverActualLogGroups(): Promise<string[]> {
        const prefixes = [
            `/v3-backend/${this.normalizedEnvironment}`,
            `/aws/ecs/v3-backend-${this.normalizedEnvironment}`,
            `/aws/lambda/v3-backend-${this.normalizedEnvironment}`,
            `/aws/vpc/flowlogs/${this.normalizedEnvironment}`,
        ];

        const allLogGroups: string[] = [];

        for (const prefix of prefixes) {
            try {
                let nextToken: string | undefined;
                do {
                    const response = await this.logsClient.send(
                        new DescribeLogGroupsCommand({
                            logGroupNamePrefix: prefix,
                            nextToken,
                        }),
                    );

                    if (response.logGroups) {
                        const names = response.logGroups.map((lg) => lg.logGroupName || '').filter((name) => name);
                        allLogGroups.push(...names);
                        console.log(`   Found ${names.length} log groups with prefix: ${prefix}`);
                        names.forEach((name) => console.log(`      - ${name}`));
                    }

                    nextToken = response.nextToken;
                } while (nextToken);
            } catch (error) {
                console.log(`   ❌ Error checking prefix ${prefix}: ${error}`);
            }
        }

        return [...new Set(allLogGroups)]; // Remove duplicates
    }

    private async checkStackResources(stackName: string): Promise<StackResourceInfo[]> {
        try {
            const response = await this.cfClient.send(
                new DescribeStackResourcesCommand({
                    StackName: stackName,
                }),
            );

            const resources =
                response.StackResources?.map((resource) => ({
                    logicalId: resource.LogicalResourceId || '',
                    physicalId: resource.PhysicalResourceId || '',
                    resourceType: resource.ResourceType || '',
                    status: resource.ResourceStatus || '',
                })) || [];

            console.log(`   Found ${resources.length} resources in ${stackName}`);

            // Show log groups and subscription filters specifically
            const logGroups = resources.filter((r) => r.resourceType === 'AWS::Logs::LogGroup');
            const subscriptionFilters = resources.filter((r) => r.resourceType === 'AWS::Logs::SubscriptionFilter');

            console.log(`      - ${logGroups.length} log groups`);
            logGroups.forEach((lg) => console.log(`        • ${lg.logicalId} → ${lg.physicalId}`));

            console.log(`      - ${subscriptionFilters.length} subscription filters`);
            subscriptionFilters.forEach((sf) => console.log(`        • ${sf.logicalId} → ${sf.physicalId}`));

            return resources;
        } catch (error) {
            console.log(`   ❌ Error checking stack ${stackName}: ${error}`);
            return [];
        }
    }

    private async checkStackOutputs(stackName: string): Promise<any[]> {
        try {
            const response = await this.cfClient.send(
                new DescribeStacksCommand({
                    StackName: stackName,
                }),
            );

            const outputs = response.Stacks?.[0]?.Outputs || [];
            console.log(`   Found ${outputs.length} outputs in ${stackName}`);
            outputs.forEach((output) => {
                console.log(`      - ${output.OutputKey}: ${output.OutputValue}`);
            });

            return outputs;
        } catch (error) {
            console.log(`   ❌ Error checking stack outputs for ${stackName}: ${error}`);
            return [];
        }
    }

    private async checkLambdaFunction(): Promise<LambdaInfo> {
        const functionName = `v3-backend-${this.normalizedEnvironment}-grafana-cloud-forwarder`;

        try {
            const response = await this.lambdaClient.send(
                new GetFunctionCommand({
                    FunctionName: functionName,
                }),
            );

            const lambdaInfo: LambdaInfo = {
                functionName,
                exists: true,
                state: response.Configuration?.State,
                lastModified: response.Configuration?.LastModified,
                arn: response.Configuration?.FunctionArn,
            };

            console.log(`   ✅ Lambda function exists`);
            console.log(`      - State: ${lambdaInfo.state}`);
            console.log(`      - Last Modified: ${lambdaInfo.lastModified}`);
            console.log(`      - ARN: ${lambdaInfo.arn}`);

            return lambdaInfo;
        } catch (error) {
            console.log(`   ❌ Lambda function not found: ${error}`);
            return {
                functionName,
                exists: false,
            };
        }
    }

    private analyzeReport(report: DebugReport): void {
        console.log('\n📊 Analysis Results:');

        // Check if expected log groups exist
        const missingLogGroups = report.expectedLogGroups.filter((lg) => !lg.exists);
        if (missingLogGroups.length > 0) {
            report.issues.push(`Missing log groups: ${missingLogGroups.map((lg) => lg.name).join(', ')}`);
            report.recommendations.push('Ensure ECS services are running and generating logs');
        }

        // Check if subscription filters exist
        const logGroupsWithoutFilters = report.expectedLogGroups.filter(
            (lg) => lg.exists && lg.subscriptionFilters.length === 0,
        );
        if (logGroupsWithoutFilters.length > 0) {
            report.issues.push(
                `Log groups without subscription filters: ${logGroupsWithoutFilters.map((lg) => lg.name).join(', ')}`,
            );
            report.recommendations.push('Create subscription filters manually or redeploy log-forwarder stack');
        }

        // Check Lambda function
        if (!report.lambdaFunction.exists) {
            report.issues.push('Lambda function does not exist');
            report.recommendations.push('Deploy log-forwarder stack');
        } else if (report.lambdaFunction.state !== 'Active') {
            report.issues.push(`Lambda function is in ${report.lambdaFunction.state} state`);
            report.recommendations.push('Check Lambda function configuration and errors');
        }

        // Check log-forwarder stack outputs
        const logGroupsCountOutput = report.logForwarderStackOutputs.find((o) => o.OutputKey === 'LogGroupsForwarded');
        if (logGroupsCountOutput && logGroupsCountOutput.OutputValue === '0') {
            report.issues.push('Log-forwarder stack shows 0 log groups forwarded');
            report.recommendations.push('Check why log groups are not being passed to log-forwarder stack');
        }

        // Display analysis
        if (report.issues.length > 0) {
            console.log('\n🚨 Issues Found:');
            report.issues.forEach((issue, index) => {
                console.log(`   ${index + 1}. ${issue}`);
            });
        }

        if (report.recommendations.length > 0) {
            console.log('\n💡 Recommendations:');
            report.recommendations.forEach((rec, index) => {
                console.log(`   ${index + 1}. ${rec}`);
            });
        }

        if (report.issues.length === 0) {
            console.log('\n✅ No obvious issues found - log forwarding should be working');
        }
    }

    displayReport(report: DebugReport): void {
        console.log('\n' + '='.repeat(80));
        console.log('📋 LOG FORWARDING DEBUG REPORT');
        console.log('='.repeat(80));
        console.log(`Environment: ${report.environment}`);
        console.log(`Region: ${report.region}`);
        console.log(`Timestamp: ${report.timestamp.toISOString()}\n`);

        // Expected vs Actual Log Groups
        console.log('📦 LOG GROUPS');
        console.log('┌─────────────────────────────────────────────────────┬────────┬─────────────────┐');
        console.log('│ Log Group Name                                      │ Exists │ Subscriptions   │');
        console.log('├─────────────────────────────────────────────────────┼────────┼─────────────────┤');

        report.expectedLogGroups.forEach((lg) => {
            const name = lg.name.length > 51 ? lg.name.substring(0, 48) + '...' : lg.name;
            const exists = lg.exists ? '✅' : '❌';
            const subs = lg.subscriptionFilters.length.toString();

            console.log(`│ ${name.padEnd(51)} │ ${exists}     │ ${subs.padStart(15)} │`);
        });

        console.log('└─────────────────────────────────────────────────────┴────────┴─────────────────┘\n');

        // Lambda Function Status
        console.log('⚡ LAMBDA FUNCTION');
        console.log(`   Function: ${report.lambdaFunction.functionName}`);
        console.log(`   Exists: ${report.lambdaFunction.exists ? '✅' : '❌'}`);
        if (report.lambdaFunction.exists) {
            console.log(`   State: ${report.lambdaFunction.state}`);
            console.log(`   Last Modified: ${report.lambdaFunction.lastModified}`);
        }
        console.log('');

        // Stack Resources Summary
        console.log('🏗️ STACK RESOURCES');
        console.log(`   Compute Stack: ${report.computeStackResources.length} resources`);
        console.log(`   Log-Forwarder Stack: ${report.logForwarderStackResources.length} resources`);

        const computeLogGroups = report.computeStackResources.filter((r) => r.resourceType === 'AWS::Logs::LogGroup');
        const forwarderSubscriptions = report.logForwarderStackResources.filter(
            (r) => r.resourceType === 'AWS::Logs::SubscriptionFilter',
        );

        console.log(`   Compute Log Groups: ${computeLogGroups.length}`);
        console.log(`   Forwarder Subscriptions: ${forwarderSubscriptions.length}\n`);

        // Issues and Recommendations
        if (report.issues.length > 0) {
            console.log('🚨 ISSUES IDENTIFIED');
            report.issues.forEach((issue, index) => {
                console.log(`   ${index + 1}. ${issue}`);
            });
            console.log('');
        }

        if (report.recommendations.length > 0) {
            console.log('💡 RECOMMENDED ACTIONS');
            report.recommendations.forEach((rec, index) => {
                console.log(`   ${index + 1}. ${rec}`);
            });
            console.log('');
        }

        console.log('='.repeat(80));
    }
}

// CLI setup
const program = new Command();

program
    .name('debug-log-forwarding')
    .description('Debug log forwarding to Grafana Cloud')
    .option('-e, --env <environment>', 'Environment to debug', 'development')
    .option('-r, --region <region>', 'AWS region', 'us-east-1')
    .option('-j, --json', 'Output JSON format')
    .option('--summary', 'Show summary only');

program.parse();

const options = program.opts();

async function main() {
    try {
        const logDebugger = new LogForwardingDebugger(options.region, options.env);
        const report = await logDebugger.debug();

        if (options.json) {
            console.log(JSON.stringify(report, null, 2));
        } else if (options.summary) {
            console.log(`\n📊 SUMMARY for ${report.environment}:`);
            console.log(`   Expected Log Groups: ${report.expectedLogGroups.length}`);
            console.log(
                `   Existing Log Groups: ${report.expectedLogGroups.filter((lg: LogGroupInfo) => lg.exists).length}`,
            );
            console.log(
                `   Groups with Subscriptions: ${
                    report.expectedLogGroups.filter((lg: LogGroupInfo) => lg.subscriptionFilters.length > 0).length
                }`,
            );
            console.log(`   Lambda Function: ${report.lambdaFunction.exists ? 'EXISTS' : 'MISSING'}`);
            console.log(`   Issues Found: ${report.issues.length}`);
        } else {
            logDebugger.displayReport(report);
        }

        // Exit with error code if issues found
        process.exit(report.issues.length > 0 ? 1 : 0);
    } catch (error) {
        console.error('❌ Debug script failed:', error);
        process.exit(2);
    }
}

if (require.main === module) {
    main();
}
