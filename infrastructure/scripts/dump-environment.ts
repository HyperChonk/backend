#!/usr/bin/env ts-node

import { Command } from 'commander';
import { writeFileSync } from 'fs';
import {
    CloudFormationClient,
    DescribeStacksCommand,
    DescribeStackEventsCommand,
    DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import {
    ECSClient,
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    DescribeClustersCommand,
    ListTasksCommand,
    DescribeTasksCommand,
    ListServicesCommand,
} from '@aws-sdk/client-ecs';
import {
    CloudWatchLogsClient,
    DescribeLogGroupsCommand,
    DescribeLogStreamsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
    ElasticLoadBalancingV2Client,
    DescribeLoadBalancersCommand,
    DescribeTargetGroupsCommand,
    DescribeListenersCommand,
    DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { SecretsManagerClient, ListSecretsCommand, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import { S3Client, ListBucketsCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { IAMClient, ListRolesCommand, GetRoleCommand, ListAttachedRolePoliciesCommand } from '@aws-sdk/client-iam';
import { normalizeEnvironmentName } from '../config/environments/shared';

interface DumpOptions {
    environment: string;
    region: string;
    output?: string;
    format: 'json' | 'yaml';
    includeSecrets: boolean;
    includeLogs: boolean;
    verbose: boolean;
}

interface EnvironmentDump {
    metadata: {
        environment: string;
        region: string;
        timestamp: string;
        dumpVersion: string;
    };
    cloudformation: {
        stacks: any[];
        stackEvents: Record<string, any[]>;
        stackResources: Record<string, any[]>;
    };
    ecs: {
        clusters: any[];
        services: any[];
        taskDefinitions: any[];
        tasks: any[];
    };
    loadBalancers: {
        loadBalancers: any[];
        targetGroups: any[];
        listeners: any[];
        targetHealth: any[];
    };
    database: {
        instances: any[];
        clusters: any[];
    };
    storage: {
        buckets: any[];
    };
    secrets: {
        secrets: any[];
        secretDetails: any[];
    };
    logs: {
        logGroups: any[];
        logStreams: Record<string, any[]>;
    };
    iam: {
        roles: any[];
        roleDetails: Record<string, any>;
    };
    errors: string[];
}

class EnvironmentDumper {
    private cfClient: CloudFormationClient;
    private ecsClient: ECSClient;
    private logsClient: CloudWatchLogsClient;
    private elbClient: ElasticLoadBalancingV2Client;
    private secretsClient: SecretsManagerClient;
    private rdsClient: RDSClient;
    private s3Client: S3Client;
    private iamClient: IAMClient;
    private options: DumpOptions;
    private normalizedEnvironment: string;
    private dump: EnvironmentDump;

    constructor(options: DumpOptions) {
        this.options = options;
        this.normalizedEnvironment = normalizeEnvironmentName(options.environment);

        const clientConfig = { region: options.region };
        this.cfClient = new CloudFormationClient(clientConfig);
        this.ecsClient = new ECSClient(clientConfig);
        this.logsClient = new CloudWatchLogsClient(clientConfig);
        this.elbClient = new ElasticLoadBalancingV2Client(clientConfig);
        this.secretsClient = new SecretsManagerClient(clientConfig);
        this.rdsClient = new RDSClient(clientConfig);
        this.s3Client = new S3Client(clientConfig);
        this.iamClient = new IAMClient(clientConfig);

        this.dump = {
            metadata: {
                environment: options.environment,
                region: options.region,
                timestamp: new Date().toISOString(),
                dumpVersion: '1.0.0',
            },
            cloudformation: {
                stacks: [],
                stackEvents: {},
                stackResources: {},
            },
            ecs: {
                clusters: [],
                services: [],
                taskDefinitions: [],
                tasks: [],
            },
            loadBalancers: {
                loadBalancers: [],
                targetGroups: [],
                listeners: [],
                targetHealth: [],
            },
            database: {
                instances: [],
                clusters: [],
            },
            storage: {
                buckets: [],
            },
            secrets: {
                secrets: [],
                secretDetails: [],
            },
            logs: {
                logGroups: [],
                logStreams: {},
            },
            iam: {
                roles: [],
                roleDetails: {},
            },
            errors: [],
        };
    }

    async dumpEnvironment(): Promise<void> {
        console.log(`🔍 Dumping environment: ${this.options.environment}`);
        console.log(`📍 Region: ${this.options.region}`);
        console.log(`📊 Include secrets: ${this.options.includeSecrets}`);
        console.log(`📋 Include logs: ${this.options.includeLogs}`);
        console.log('─'.repeat(80));

        const tasks = [
            { name: 'CloudFormation Stacks', fn: () => this.dumpCloudFormation() },
            { name: 'ECS Resources', fn: () => this.dumpECS() },
            { name: 'Load Balancers', fn: () => this.dumpLoadBalancers() },
            { name: 'Database Resources', fn: () => this.dumpDatabase() },
            { name: 'Storage Resources', fn: () => this.dumpStorage() },
            { name: 'IAM Roles', fn: () => this.dumpIAM() },
        ];

        if (this.options.includeSecrets) {
            tasks.push({ name: 'Secrets', fn: () => this.dumpSecrets() });
        }

        if (this.options.includeLogs) {
            tasks.push({ name: 'Log Groups', fn: () => this.dumpLogs() });
        }

        for (const task of tasks) {
            try {
                console.log(`📦 Collecting ${task.name}...`);
                await task.fn();
                console.log(`✅ ${task.name} collected`);
            } catch (error) {
                const errorMsg = `❌ Failed to collect ${task.name}: ${
                    error instanceof Error ? error.message : String(error)
                }`;
                console.error(errorMsg);
                this.dump.errors.push(errorMsg);
            }
        }

        await this.saveDump();
    }

    private async dumpCloudFormation(): Promise<void> {
        const stackNames = this.getStackNames();

        for (const stackName of stackNames) {
            try {
                const stackResponse = await this.cfClient.send(new DescribeStacksCommand({ StackName: stackName }));

                if (stackResponse.Stacks?.[0]) {
                    this.dump.cloudformation.stacks.push(stackResponse.Stacks[0]);

                    const eventsResponse = await this.cfClient.send(
                        new DescribeStackEventsCommand({ StackName: stackName }),
                    );
                    this.dump.cloudformation.stackEvents[stackName] = eventsResponse.StackEvents || [];

                    // Log recent failed events for debugging
                    if (this.options.verbose) {
                        const failedEvents = (eventsResponse.StackEvents || [])
                            .filter(
                                (event) =>
                                    event.ResourceStatus?.includes('FAILED') ||
                                    event.ResourceStatus?.includes('ROLLBACK'),
                            )
                            .slice(0, 5); // Last 5 failed events

                        if (failedEvents.length > 0) {
                            console.log(`⚠️  Recent failed events in ${stackName}:`);
                            failedEvents.forEach((event) => {
                                console.log(`   ${event.LogicalResourceId}: ${event.ResourceStatus}`);
                                if (event.ResourceStatusReason) {
                                    console.log(`   Reason: ${event.ResourceStatusReason}`);
                                }
                            });
                        }
                    }

                    const resourcesResponse = await this.cfClient.send(
                        new DescribeStackResourcesCommand({ StackName: stackName }),
                    );
                    this.dump.cloudformation.stackResources[stackName] = resourcesResponse.StackResources || [];
                }
            } catch (error) {
                if (this.options.verbose) {
                    console.log(`⚠️  Stack ${stackName} not found or inaccessible`);
                }
            }
        }
    }

    private async dumpECS(): Promise<void> {
        const clusterName = `v3-backend-${this.normalizedEnvironment}-cluster`;

        try {
            const clusterResponse = await this.ecsClient.send(new DescribeClustersCommand({ clusters: [clusterName] }));
            this.dump.ecs.clusters = clusterResponse.clusters || [];

            const servicesResponse = await this.ecsClient.send(new ListServicesCommand({ cluster: clusterName }));

            if (servicesResponse.serviceArns && servicesResponse.serviceArns.length > 0) {
                const serviceDetailsResponse = await this.ecsClient.send(
                    new DescribeServicesCommand({
                        cluster: clusterName,
                        services: servicesResponse.serviceArns,
                    }),
                );
                this.dump.ecs.services = serviceDetailsResponse.services || [];

                const taskDefinitionArns = new Set<string>();
                for (const service of serviceDetailsResponse.services || []) {
                    if (service.taskDefinition) {
                        taskDefinitionArns.add(service.taskDefinition);
                    }
                }

                for (const taskDefArn of taskDefinitionArns) {
                    try {
                        const taskDefResponse = await this.ecsClient.send(
                            new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }),
                        );
                        if (taskDefResponse.taskDefinition) {
                            this.dump.ecs.taskDefinitions.push(taskDefResponse.taskDefinition);
                        }
                    } catch (error) {
                        this.dump.errors.push(`Failed to get task definition ${taskDefArn}: ${error}`);
                    }
                }

                // Get both running and stopped tasks for better debugging
                const runningTasksResponse = await this.ecsClient.send(
                    new ListTasksCommand({ cluster: clusterName, desiredStatus: 'RUNNING' }),
                );

                const stoppedTasksResponse = await this.ecsClient.send(
                    new ListTasksCommand({ cluster: clusterName, desiredStatus: 'STOPPED' }),
                );

                // Combine all task ARNs (limit stopped tasks to last 10 for performance)
                const allTaskArns = [
                    ...(runningTasksResponse.taskArns || []),
                    ...(stoppedTasksResponse.taskArns || []).slice(0, 10),
                ];

                if (allTaskArns.length > 0) {
                    const taskDetailsResponse = await this.ecsClient.send(
                        new DescribeTasksCommand({
                            cluster: clusterName,
                            tasks: allTaskArns,
                            include: ['TAGS'], // Include additional metadata
                        }),
                    );
                    this.dump.ecs.tasks = taskDetailsResponse.tasks || [];

                    // Log task failure details for debugging
                    const failedTasks = this.dump.ecs.tasks.filter(
                        (task) => task.lastStatus === 'STOPPED' && task.stopCode !== 'TaskCompletedSuccessfully',
                    );

                    if (failedTasks.length > 0 && this.options.verbose) {
                        console.log(`⚠️  Found ${failedTasks.length} failed tasks with errors`);
                        failedTasks.forEach((task) => {
                            console.log(`   Task: ${task.taskArn?.split('/').pop()}`);
                            console.log(`   Stop Code: ${task.stopCode}`);
                            console.log(`   Stop Reason: ${task.stoppedReason}`);

                            // Check container exit reasons
                            task.containers?.forEach((container: any) => {
                                if (container.exitCode !== 0 || container.reason) {
                                    console.log(
                                        `   Container ${container.name}: Exit Code ${container.exitCode}, Reason: ${container.reason}`,
                                    );
                                }
                            });
                        });
                    }
                }
            }
        } catch (error) {
            this.dump.errors.push(`Failed to get ECS resources: ${error}`);
        }
    }

    private async dumpLoadBalancers(): Promise<void> {
        try {
            const lbResponse = await this.elbClient.send(new DescribeLoadBalancersCommand({}));
            const environmentLBs = (lbResponse.LoadBalancers || []).filter((lb) =>
                lb.LoadBalancerName?.includes(this.normalizedEnvironment),
            );
            this.dump.loadBalancers.loadBalancers = environmentLBs;

            const tgResponse = await this.elbClient.send(new DescribeTargetGroupsCommand({}));
            const environmentTGs = (tgResponse.TargetGroups || []).filter((tg) =>
                tg.TargetGroupName?.includes(this.normalizedEnvironment),
            );
            this.dump.loadBalancers.targetGroups = environmentTGs;

            for (const lb of environmentLBs) {
                if (lb.LoadBalancerArn) {
                    try {
                        const listenersResponse = await this.elbClient.send(
                            new DescribeListenersCommand({ LoadBalancerArn: lb.LoadBalancerArn }),
                        );
                        this.dump.loadBalancers.listeners.push(...(listenersResponse.Listeners || []));
                    } catch (error) {
                        this.dump.errors.push(`Failed to get listeners for LB ${lb.LoadBalancerName}: ${error}`);
                    }
                }
            }

            for (const tg of environmentTGs) {
                if (tg.TargetGroupArn) {
                    try {
                        const healthResponse = await this.elbClient.send(
                            new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }),
                        );
                        this.dump.loadBalancers.targetHealth.push({
                            targetGroupArn: tg.TargetGroupArn,
                            targetGroupName: tg.TargetGroupName,
                            targets: healthResponse.TargetHealthDescriptions || [],
                        });
                    } catch (error) {
                        this.dump.errors.push(`Failed to get target health for TG ${tg.TargetGroupName}: ${error}`);
                    }
                }
            }
        } catch (error) {
            this.dump.errors.push(`Failed to get load balancer resources: ${error}`);
        }
    }

    private async dumpDatabase(): Promise<void> {
        try {
            const instancesResponse = await this.rdsClient.send(new DescribeDBInstancesCommand({}));
            const environmentInstances = (instancesResponse.DBInstances || []).filter((instance) =>
                instance.DBInstanceIdentifier?.includes(this.normalizedEnvironment),
            );
            this.dump.database.instances = environmentInstances;

            const clustersResponse = await this.rdsClient.send(new DescribeDBClustersCommand({}));
            const environmentClusters = (clustersResponse.DBClusters || []).filter((cluster) =>
                cluster.DBClusterIdentifier?.includes(this.normalizedEnvironment),
            );
            this.dump.database.clusters = environmentClusters;
        } catch (error) {
            this.dump.errors.push(`Failed to get database resources: ${error}`);
        }
    }

    private async dumpStorage(): Promise<void> {
        try {
            const bucketsResponse = await this.s3Client.send(new ListBucketsCommand({}));
            const environmentBuckets = (bucketsResponse.Buckets || []).filter((bucket) =>
                bucket.Name?.includes(this.normalizedEnvironment),
            );

            for (const bucket of environmentBuckets) {
                try {
                    const locationResponse = await this.s3Client.send(
                        new GetBucketLocationCommand({ Bucket: bucket.Name }),
                    );
                    (bucket as any).region = locationResponse.LocationConstraint || 'us-east-1';
                } catch (error) {
                    this.dump.errors.push(`Failed to get location for bucket ${bucket.Name}: ${error}`);
                }
            }

            this.dump.storage.buckets = environmentBuckets;
        } catch (error) {
            this.dump.errors.push(`Failed to get storage resources: ${error}`);
        }
    }

    private async dumpSecrets(): Promise<void> {
        try {
            const secretsResponse = await this.secretsClient.send(new ListSecretsCommand({}));
            const environmentSecrets = (secretsResponse.SecretList || []).filter((secret) =>
                secret.Name?.includes(this.normalizedEnvironment),
            );
            this.dump.secrets.secrets = environmentSecrets;

            for (const secret of environmentSecrets) {
                if (secret.ARN) {
                    try {
                        const secretResponse = await this.secretsClient.send(
                            new DescribeSecretCommand({ SecretId: secret.ARN }),
                        );
                        this.dump.secrets.secretDetails.push(secretResponse);
                    } catch (error) {
                        this.dump.errors.push(`Failed to get secret details for ${secret.Name}: ${error}`);
                    }
                }
            }
        } catch (error) {
            this.dump.errors.push(`Failed to get secrets: ${error}`);
        }
    }

    private async dumpLogs(): Promise<void> {
        try {
            const logGroupsResponse = await this.logsClient.send(new DescribeLogGroupsCommand({}));
            const environmentLogGroups = (logGroupsResponse.logGroups || []).filter((logGroup) =>
                logGroup.logGroupName?.includes(this.normalizedEnvironment),
            );
            this.dump.logs.logGroups = environmentLogGroups;

            for (const logGroup of environmentLogGroups.slice(0, 10)) {
                if (logGroup.logGroupName) {
                    try {
                        const streamsResponse = await this.logsClient.send(
                            new DescribeLogStreamsCommand({
                                logGroupName: logGroup.logGroupName,
                                orderBy: 'LastEventTime',
                                descending: true,
                                limit: 5,
                            }),
                        );
                        this.dump.logs.logStreams[logGroup.logGroupName] = streamsResponse.logStreams || [];
                    } catch (error) {
                        this.dump.errors.push(`Failed to get log streams for ${logGroup.logGroupName}: ${error}`);
                    }
                }
            }
        } catch (error) {
            this.dump.errors.push(`Failed to get log resources: ${error}`);
        }
    }

    private async dumpIAM(): Promise<void> {
        try {
            const rolesResponse = await this.iamClient.send(new ListRolesCommand({}));
            const environmentRoles = (rolesResponse.Roles || []).filter((role) =>
                role.RoleName?.includes(this.normalizedEnvironment),
            );
            this.dump.iam.roles = environmentRoles;

            for (const role of environmentRoles) {
                if (role.RoleName) {
                    try {
                        const roleResponse = await this.iamClient.send(new GetRoleCommand({ RoleName: role.RoleName }));

                        const policiesResponse = await this.iamClient.send(
                            new ListAttachedRolePoliciesCommand({ RoleName: role.RoleName }),
                        );

                        this.dump.iam.roleDetails[role.RoleName] = {
                            role: roleResponse.Role,
                            attachedPolicies: policiesResponse.AttachedPolicies || [],
                        };
                    } catch (error) {
                        this.dump.errors.push(`Failed to get role details for ${role.RoleName}: ${error}`);
                    }
                }
            }
        } catch (error) {
            this.dump.errors.push(`Failed to get IAM resources: ${error}`);
        }
    }

    private getStackNames(): string[] {
        const baseStacks = [
            'networking',
            'security',
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

    private async saveDump(): Promise<void> {
        const filename =
            this.options.output ||
            `environment-dump-${this.normalizedEnvironment}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

        const content = JSON.stringify(this.dump, null, 2);
        writeFileSync(filename, content);

        console.log('\n📋 Environment Dump Summary:');
        console.log(`📁 Output file: ${filename}`);
        console.log(`📊 CloudFormation stacks: ${this.dump.cloudformation.stacks.length}`);
        console.log(`🚀 ECS services: ${this.dump.ecs.services.length}`);
        console.log(`📝 Task definitions: ${this.dump.ecs.taskDefinitions.length}`);
        console.log(`⚖️  Load balancers: ${this.dump.loadBalancers.loadBalancers.length}`);
        console.log(`🗄️  Database instances: ${this.dump.database.instances.length}`);
        console.log(`🪣 S3 buckets: ${this.dump.storage.buckets.length}`);
        console.log(`🔐 Secrets: ${this.dump.secrets.secrets.length}`);
        console.log(`📋 Log groups: ${this.dump.logs.logGroups.length}`);
        console.log(`👤 IAM roles: ${this.dump.iam.roles.length}`);
        console.log(`❌ Errors: ${this.dump.errors.length}`);

        if (this.dump.errors.length > 0) {
            console.log('\n⚠️  Errors encountered:');
            this.dump.errors.forEach((error) => console.log(`   • ${error}`));
        }

        console.log(`\n✅ Environment dump saved to: ${filename}`);
        console.log(`📏 File size: ${(content.length / 1024).toFixed(2)} KB`);
    }
}

async function main() {
    const program = new Command();

    program
        .name('dump-environment')
        .description('Dump comprehensive AWS environment details for debugging')
        .version('1.0.0');

    program
        .option('-e, --environment <env>', 'Environment to dump', 'development')
        .option('-r, --region <region>', 'AWS region', 'us-east-1')
        .option('-o, --output <filename>', 'Output filename')
        .option('-f, --format <format>', 'Output format (json, yaml)', 'json')
        .option('-s, --include-secrets', 'Include secrets metadata', false)
        .option('-l, --include-logs', 'Include log groups and streams', false)
        .option('-v, --verbose', 'Verbose output', false);

    program.parse();

    const options = program.opts() as DumpOptions;

    const dumper = new EnvironmentDumper(options);
    await dumper.dumpEnvironment();
}

if (require.main === module) {
    main().catch(console.error);
}
