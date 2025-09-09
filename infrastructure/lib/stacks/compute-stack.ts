import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as applicationAutoscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { EnvironmentConfig } from '../../config/shared/types';
import { generateResourceName, SHARED_CONFIG } from '../../config/environments/shared';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';

export interface ComputeStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
    vpc: ec2.IVpc;
    albSecurityGroup: ec2.ISecurityGroup;
    ecsSecurityGroup: ec2.ISecurityGroup;
    database: rds.DatabaseInstance;
    queues: {
        backgroundJobQueue: sqs.Queue;
        dataRefreshQueue: sqs.Queue;
        notificationQueue: sqs.Queue;
    };
    sqsEncryptionKeyArn: string;
    certificate?: acm.ICertificate;
    wafWebAclArn?: string;
    hostedZone?: route53.IHostedZone;
    logsBucket?: s3.IBucket;
}

export class ComputeStack extends cdk.Stack {
    public readonly cluster: ecs.Cluster;
    public readonly apiService: ecs.FargateService;
    public readonly workerService: ecs.FargateService;
    public readonly schedulerService: ecs.FargateService;
    public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
    public readonly apiTaskDefinition: ecs.FargateTaskDefinition;
    public readonly workerTaskDefinition: ecs.FargateTaskDefinition;
    public readonly schedulerTaskDefinition: ecs.FargateTaskDefinition;
    public readonly migrationTaskDefinition: ecs.FargateTaskDefinition;
    public readonly apiLogGroup: logs.LogGroup;
    public readonly workerLogGroup: logs.LogGroup;
    public readonly schedulerLogGroup: logs.LogGroup;
    public readonly migrationLogGroup: logs.LogGroup;

    constructor(scope: Construct, id: string, props: ComputeStackProps) {
        super(scope, id, props);

        const {
            config,
            vpc,
            albSecurityGroup,
            ecsSecurityGroup,
            database,
            queues,
            sqsEncryptionKeyArn,
            certificate,
            wafWebAclArn,
            hostedZone,
        } = props;

        // Validate certificate requirement
        if (config.loadBalancer.ssl?.enabled && !certificate) {
            throw new Error(`SSL is enabled for ${config.environment} but no certificate was provided`);
        }

        // Create ECS Cluster
        this.cluster = new ecs.Cluster(this, 'Cluster', {
            clusterName: generateResourceName('cluster', config.environment),
            vpc: vpc,
            enableFargateCapacityProviders: true,
        });

        // Create Application Load Balancer
        this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
            loadBalancerName: generateResourceName('alb', config.environment),
            vpc: vpc,
            internetFacing: true,
            securityGroup: albSecurityGroup,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            idleTimeout: cdk.Duration.seconds(config.loadBalancer.idleTimeout),
        });

        // Enable ALB access logs if configured and bucket provided
        if (config.loadBalancer.enableAccessLogs && (props as any).logsBucket) {
            const logBucket = (props as any).logsBucket as s3.IBucket;
            this.loadBalancer.logAccessLogs(logBucket, `alb-logs/${config.environment}`);
        }

        // Associate WAF with ALB if available
        if (wafWebAclArn && config.security.enableWaf) {
            this.associateWafWithAlb(wafWebAclArn);
        }

        // Create DNS record if SSL is configured
        if (config.loadBalancer.ssl?.enabled && config.loadBalancer.ssl.rootDomain && hostedZone) {
            new route53.ARecord(this, 'AlbDnsRecord', {
                zone: hostedZone,
                recordName: config.loadBalancer.ssl.domainName.replace(`.${config.loadBalancer.ssl.rootDomain}`, ''),
                target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.loadBalancer)),
                comment: `Alias record for ${config.environment} ALB`,
            });
            console.log(`✅ Created A-Record for ${config.loadBalancer.ssl.domainName}`);
        }

        // Create Task Execution Role
        const taskExecutionRole = this.createTaskExecutionRole(config);

        // Create Task Role
        const taskRole = this.createTaskRole(config, queues, sqsEncryptionKeyArn);

        // Create log groups
        this.apiLogGroup = new logs.LogGroup(this, 'APILogGroup', {
            logGroupName: `/v3-backend/${config.environment}/api`,
            retention: config.monitoring.logRetention,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        this.workerLogGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
            logGroupName: `/v3-backend/${config.environment}/worker`,
            retention: config.monitoring.logRetention,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        this.schedulerLogGroup = new logs.LogGroup(this, 'SchedulerLogGroup', {
            logGroupName: `/v3-backend/${config.environment}/scheduler`,
            retention: config.monitoring.logRetention,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        this.migrationLogGroup = new logs.LogGroup(this, 'MigrationLogGroup', {
            logGroupName: `/v3-backend/${config.environment}/migration`,
            retention: config.monitoring.logRetention,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        // Create Task Definitions
        this.apiTaskDefinition = this.createApiTaskDefinition(config, taskExecutionRole, taskRole, queues, database);
        this.workerTaskDefinition = this.createWorkerTaskDefinition(
            config,
            taskExecutionRole,
            taskRole,
            queues,
            database,
        );
        this.schedulerTaskDefinition = this.createSchedulerTaskDefinition(
            config,
            taskExecutionRole,
            taskRole,
            queues,
            database,
        );
        this.migrationTaskDefinition = this.createMigrationTaskDefinition(
            config,
            taskExecutionRole,
            taskRole,
            this.migrationLogGroup,
            database,
        );

        // Create Target Group and ALB Listener
        const targetGroup = this.createTargetGroup(config, vpc);
        this.createAlbListener(config, targetGroup, certificate);

        // Create ECS Services
        this.apiService = this.createApiService(config, vpc, ecsSecurityGroup, targetGroup);
        this.workerService = this.createWorkerService(config, vpc, ecsSecurityGroup);
        this.schedulerService = this.createSchedulerService(config, vpc, ecsSecurityGroup);

        // Queues are now passed directly as props
        const { backgroundJobQueue, dataRefreshQueue, notificationQueue } = queues;

        // Configure Auto Scaling
        this.configureApiAutoScaling(config);
        this.configureWorkerAutoScaling(config, backgroundJobQueue, dataRefreshQueue, notificationQueue);
        this.configureSchedulerAutoScaling(config);

        // SSM parameter for current image tag tracking is managed by GitHub workflow
        // to avoid CloudFormation ownership conflicts

        // Export log group ARNs for log forwarder stack
        this.exportLogGroupArns(config);

        // Apply tags
        this.applyTags(config);

        // Create CloudFormation outputs
        this.createOutputs(config);
    }

    private associateWafWithAlb(webAclArn: string): void {
        new wafv2.CfnWebACLAssociation(this, 'WafAlbAssociation', {
            resourceArn: this.loadBalancer.loadBalancerArn,
            webAclArn: webAclArn,
        });
    }

    private createTaskExecutionRole(config: EnvironmentConfig): iam.Role {
        const role = new iam.Role(this, 'TaskExecutionRole', {
            roleName: generateResourceName('task-execution-role', config.environment),
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });

        // Grant access to all application secrets
        role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
                resources: [
                    `arn:aws:secretsmanager:${this.region}:${this.account}:secret:v3-backend/${config.environment}/*`,
                ],
            }),
        );

        // Explicitly grant access to the database credentials secret, which is referenced by ARN
        role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['secretsmanager:GetSecretValue'],
                resources: [
                    `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${generateResourceName(
                        'database-credentials',
                        config.environment,
                    )}*`,
                ],
            }),
        );

        role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [
                    `arn:aws:logs:${this.region}:${this.account}:log-group:/v3-backend/${config.environment}/*`,
                ],
            }),
        );

        role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'ecr:GetAuthorizationToken',
                    'ecr:BatchCheckLayerAvailability',
                    'ecr:GetDownloadUrlForLayer',
                    'ecr:BatchGetImage',
                ],
                resources: ['*'],
            }),
        );

        return role;
    }

    private createTaskRole(
        config: EnvironmentConfig,
        queues: { backgroundJobQueue: sqs.Queue; dataRefreshQueue: sqs.Queue; notificationQueue: sqs.Queue },
        sqsEncryptionKeyArn: string,
    ): iam.Role {
        const role = new iam.Role(this, 'TaskRole', {
            roleName: generateResourceName('task-role', config.environment),
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
                resources: [`arn:aws:secretsmanager:${this.region}:*:secret:v3-backend/${config.environment}/*`],
            }),
        );

        role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
                resources: [
                    queues.backgroundJobQueue.queueArn,
                    queues.dataRefreshQueue.queueArn,
                    queues.notificationQueue.queueArn,
                ],
            }),
        );

        // Add KMS permissions for SQS encryption/decryption
        role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
                resources: [sqsEncryptionKeyArn],
            }),
        );

        // Add SSM Parameter Store permissions for infrastructure version tracking
        role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['ssm:GetParameter', 'ssm:GetParameters'],
                resources: [
                    `arn:aws:ssm:${this.region}:*:parameter/v3-backend/${config.environment}/infrastructure/*`,
                    `arn:aws:ssm:${this.region}:*:parameter/v3-backend/${config.environment}/compute/*`,
                ],
            }),
        );

        role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
                resources: [
                    `arn:aws:s3:::${generateResourceName('artifacts', config.environment)}`,
                    `arn:aws:s3:::${generateResourceName('artifacts', config.environment)}/*`,
                    `arn:aws:s3:::${generateResourceName('assets', config.environment)}`,
                    `arn:aws:s3:::${generateResourceName('assets', config.environment)}/*`,
                    `arn:aws:s3:::${generateResourceName('backups', config.environment)}`,
                    `arn:aws:s3:::${generateResourceName('backups', config.environment)}/*`,
                ],
            }),
        );

        role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['cloudwatch:PutMetricData'],
                resources: ['*'],
            }),
        );

        return role;
    }

    /**
     * Helper method to create container definitions with shared configuration
     *
     * Key features:
     * - Manages environment variables vs secrets conflicts (SQS URLs come from SSM, not secrets)
     * - Uses SQS URLs directly from SSM parameters (more reliable than ARN conversion)
     * - Constructs DATABASE_URL dynamically from database stack outputs
     * - Caches database parameters to avoid duplicate construct creation
     * - Suppresses false-positive ECR policy warnings
     */
    private createBaseContainerDefinition(
        taskDefinition: ecs.FargateTaskDefinition,
        name: 'api' | 'worker' | 'scheduler' | 'migration',
        logGroup: logs.ILogGroup,
        config: EnvironmentConfig,
        queues: {
            backgroundJobQueue?: sqs.Queue;
            dataRefreshQueue?: sqs.Queue;
            notificationQueue?: sqs.Queue;
        },
        configSecret: secretsmanager.ISecret,
        database: rds.DatabaseInstance,
        command?: string[],
    ): ecs.ContainerDefinition {
        const imageUri = this.getImageUri();

        // 🔥 FORCE DEPLOYMENT: Add deployment timestamp to ensure CloudFormation sees changes
        // This forces task definition updates on every deployment, regardless of environment variable changes
        const deploymentTimestamp = this.node.tryGetContext('deploymentTimestamp') || new Date().toISOString();
        const deploymentId = this.node.tryGetContext('deploymentId') || Date.now().toString();

        // Define non-sensitive environment variables that come from CDK config
        const environmentVariables: Record<string, string> = {
            SERVICE_TYPE: name,
            // 🔥 FORCE DEPLOYMENT: Add deployment identifiers to force container updates
            DEPLOYMENT_TIMESTAMP: deploymentTimestamp,
            DEPLOYMENT_ID: deploymentId,
            // Add SQS queue URLs that the application expects
            ...(queues.backgroundJobQueue && {
                SQS_BACKGROUND_JOB_QUEUE_URL: queues.backgroundJobQueue.queueUrl,
            }),
            ...(queues.dataRefreshQueue && {
                SQS_DATA_REFRESH_QUEUE_URL: queues.dataRefreshQueue.queueUrl,
            }),
            ...(queues.notificationQueue && {
                SQS_NOTIFICATION_QUEUE_URL: queues.notificationQueue.queueUrl,
            }),
        };

        const container = taskDefinition.addContainer(name, {
            containerName: `v3-backend-${name}`,
            image: ecs.ContainerImage.fromRegistry(imageUri),
            environment: environmentVariables,
            command,
            healthCheck:
                name === 'worker'
                    ? {
                          command: ['CMD-SHELL', 'curl -f http://localhost:8080/health/deep || exit 1'],
                          interval: cdk.Duration.seconds(30),
                          timeout: cdk.Duration.seconds(10),
                          retries: 3,
                          startPeriod: cdk.Duration.seconds(60),
                      }
                    : undefined,
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: name,
                logGroup: logGroup,
            }),
            stopTimeout: cdk.Duration.seconds(SHARED_CONFIG.container.gracefulShutdownTimeout),
        });

        // Suppress CDK warning about ECR policies - our task execution role already has proper ECR permissions
        cdk.Annotations.of(container).acknowledgeWarning(
            '@aws-cdk/aws-ecs:ecrImageRequiresPolicy',
            'Task execution role already has ECR permissions configured',
        );

        // Add individual environment variables from the config secret
        // This allows the application to access them as standard environment variables
        const secretKeys = [
            'PORT',
            'NODE_ENV',
            'DEFAULT_CHAIN_ID',
            'DEPLOYMENT_ENV',
            'ADMIN_API_KEY',
            'SANITY_API_TOKEN',
            'SENTRY_DSN',
            'SENTRY_AUTH_TOKEN',
            'SENTRY_PROFILES_SAMPLE_RATE',
            'SENTRY_TRACES_SAMPLE_RATE',
            'APOLLO_SCHEMA_REPORTING',
            'LOG_LEVEL',
            'PROTOCOL',
            'ALCHEMY_API_KEY',
            'COINGECKO_API_KEY',
            'DRPC_API_KEY',
            'DRPC_BEETS_API_KEY',
            'RPC_API_KEY',
            'RPC_URL_TEMPLATE',
            'SATSUMA_API_KEY',
            'THEGRAPH_API_KEY_BALANCER',
            'THEGRAPH_API_KEY_FANTOM',
            'WHITELISTED_CHAINS',
            'AWS_REGION',
            'AWS_ALERTS',
            'GRAFANA_CLOUD_API_KEY',
            'GRAFANA_CLOUD_LOKI_ENDPOINT',
            'GRAFANA_CLOUD_USER_ID',
            // Note: SCHEDULER and WORKER are set as environment variables below based on service type
        ];

        // Add each secret key as an individual environment variable
        secretKeys.forEach((key) => {
            container.addSecret(key, ecs.Secret.fromSecretsManager(configSecret, key));
        });

        // Override service-specific environment variables based on service type
        switch (name) {
            case 'api':
                container.addEnvironment('WORKER', 'false');
                container.addEnvironment('SCHEDULER', 'false');
                break;
            case 'worker':
                container.addEnvironment('WORKER', 'true');
                container.addEnvironment('SCHEDULER', 'false');
                break;
            case 'scheduler':
                container.addEnvironment('WORKER', 'false');
                container.addEnvironment('SCHEDULER', 'true');
                break;
            case 'migration':
                // Migration service doesn't need these overrides
                break;
        }

        // Construct DATABASE_URL from the RDS-generated db-credentials secret
        // We need to use the database prop that was passed to this method
        if (!database || !database.secret) {
            throw new Error(
                `Database instance with secret is required for ${name} container. This is a critical configuration error.`,
            );
        }

        // Use the secret from the database instance which contains the credentials
        const dbSecret = database.secret;

        // Construct DATABASE_URL using CloudFormation intrinsic functions
        const databaseUrl = cdk.Fn.join('', [
            'postgresql://',
            dbSecret.secretValueFromJson('username').unsafeUnwrap(),
            ':',
            dbSecret.secretValueFromJson('password').unsafeUnwrap(),
            '@',
            database.instanceEndpoint.hostname,
            ':',
            database.instanceEndpoint.port.toString(),
            '/',
            dbSecret.secretValueFromJson('dbname').unsafeUnwrap(),
        ]);

        container.addEnvironment('DATABASE_URL', databaseUrl);

        return container;
    }

    /**
     * DEPRECATED: No longer needed since QueueLookup provides URLs directly
     * Helper method to convert SQS queue ARN to queue URL
     */
    private getQueueUrlFromArn(queueArn: string): string {
        // SQS ARN format: arn:aws:sqs:region:account-id:queue-name
        // SQS URL format: https://sqs.region.amazonaws.com/account-id/queue-name
        const arnParts = queueArn.split(':');
        const region = arnParts[3];
        const accountId = arnParts[4];
        const queueName = arnParts[5];

        return `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
    }

    /**
     * ✅ FIXED: Proper configuration management
     * - Sensitive config comes from Secrets Manager (individual environment variables)
     * - Non-sensitive config (SQS URLs from SSM, service type) comes from CDK
     * - SQS URLs are retrieved directly from SSM parameters (not converted from ARNs)
     */

    private createApiTaskDefinition(
        config: EnvironmentConfig,
        executionRole: iam.Role,
        taskRole: iam.Role,
        queues: { backgroundJobQueue: sqs.Queue; dataRefreshQueue: sqs.Queue; notificationQueue: sqs.Queue },
        database: rds.DatabaseInstance,
    ): ecs.FargateTaskDefinition {
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'APITaskDefinition', {
            family: generateResourceName('api-task', config.environment),
            cpu: config.resources.cpu,
            memoryLimitMiB: config.resources.memoryMiB,
            executionRole,
            taskRole,
        });

        const configSecret = secretsmanager.Secret.fromSecretNameV2(
            this,
            'ConfigSecret',
            `v3-backend/${config.environment}/config`,
        );

        // ✅ FIXED: All configuration comes from Secrets Manager as individual environment variables
        const container = this.createBaseContainerDefinition(
            taskDefinition,
            'api',
            this.apiLogGroup,
            config,
            queues,
            configSecret,
            database,
        );

        container.addPortMappings({
            containerPort: 4000,
            protocol: ecs.Protocol.TCP,
        });

        return taskDefinition;
    }

    private createWorkerTaskDefinition(
        config: EnvironmentConfig,
        executionRole: iam.Role,
        taskRole: iam.Role,
        queues: { backgroundJobQueue: sqs.Queue; dataRefreshQueue: sqs.Queue; notificationQueue: sqs.Queue },
        database: rds.DatabaseInstance,
    ): ecs.FargateTaskDefinition {
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'WorkerTaskDefinition', {
            family: generateResourceName('worker-task', config.environment),
            cpu: Math.max(256, config.resources.cpu / 2),
            memoryLimitMiB: Math.max(512, config.resources.memoryMiB / 2),
            executionRole,
            taskRole,
        });

        const configSecret = secretsmanager.Secret.fromSecretNameV2(
            this,
            'WorkerConfigSecret',
            `v3-backend/${config.environment}/config`,
        );

        // ✅ FIXED: All configuration comes from Secrets Manager as individual environment variables
        const container = this.createBaseContainerDefinition(
            taskDefinition,
            'worker',
            this.workerLogGroup,
            config,
            queues,
            configSecret,
            database,
        );

        // Worker no longer needs HTTP port - uses SQS polling

        return taskDefinition;
    }

    private createSchedulerTaskDefinition(
        config: EnvironmentConfig,
        executionRole: iam.Role,
        taskRole: iam.Role,
        queues: { backgroundJobQueue: sqs.Queue; dataRefreshQueue: sqs.Queue; notificationQueue: sqs.Queue },
        database: rds.DatabaseInstance,
    ): ecs.FargateTaskDefinition {
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'SchedulerTaskDefinition', {
            family: generateResourceName('scheduler-task', config.environment),
            cpu: 256, // Minimal CPU for scheduler
            memoryLimitMiB: 512, // Minimal memory
            executionRole,
            taskRole,
        });

        const configSecret = secretsmanager.Secret.fromSecretNameV2(
            this,
            'SchedulerConfigSecret',
            `v3-backend/${config.environment}/config`,
        );

        // ✅ FIXED: All configuration comes from Secrets Manager as individual environment variables
        const container = this.createBaseContainerDefinition(
            taskDefinition,
            'scheduler',
            this.schedulerLogGroup,
            config,
            queues,
            configSecret,
            database,
        );

        // Scheduler does not expose an HTTP health endpoint by default; rely on service-level monitoring

        return taskDefinition;
    }

    private createMigrationTaskDefinition(
        config: EnvironmentConfig,
        executionRole: iam.Role,
        taskRole: iam.Role,
        migrationLogGroup: logs.LogGroup,
        database: rds.DatabaseInstance,
    ): ecs.FargateTaskDefinition {
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'MigrationTaskDefinition', {
            family: generateResourceName('migration-task', config.environment),
            cpu: Math.max(256, config.resources.cpu / 2),
            memoryLimitMiB: Math.max(512, config.resources.memoryMiB / 2),
            executionRole,
            taskRole,
        });

        const configSecret = secretsmanager.Secret.fromSecretNameV2(
            this,
            'MigrationConfigSecret',
            `v3-backend/${config.environment}/config`,
        );

        // ✅ FIXED: All configuration comes from Secrets Manager as individual environment variables
        // Migration command - simplified since AWS RDS handles automated backups
        const migrationCommand = [
            '/bin/sh',
            '-c',
            'echo "Starting database migration..." && ' +
                'bunx prisma migrate deploy && ' +
                'bunx prisma migrate status && ' +
                'echo "Migration completed successfully"',
        ];

        this.createBaseContainerDefinition(
            taskDefinition,
            'migration',
            migrationLogGroup,
            config,
            {}, // Migration doesn't need queues
            configSecret,
            database,
            migrationCommand,
        );

        return taskDefinition;
    }

    private createTargetGroup(config: EnvironmentConfig, vpc: ec2.IVpc): elbv2.ApplicationTargetGroup {
        const tg = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
            targetGroupName: generateResourceName('api-tg', config.environment),
            port: 4000,
            protocol: elbv2.ApplicationProtocol.HTTP,
            vpc,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                enabled: true,
                healthyHttpCodes: '200',
                interval: cdk.Duration.seconds(config.loadBalancer.healthCheckInterval),
                timeout: cdk.Duration.seconds(config.loadBalancer.healthCheckTimeout),
                healthyThresholdCount: config.loadBalancer.healthyThresholdCount,
                unhealthyThresholdCount: config.loadBalancer.unhealthyThresholdCount,
                path: '/health', // Use proper health endpoint
                port: '4000',
                protocol: elbv2.Protocol.HTTP,
            },
        });
        // Reduce connection draining to speed up deployments while still allowing in-flight requests to complete
        tg.setAttribute('deregistration_delay.timeout_seconds', '60');
        return tg;
    }

    private createAlbListener(
        config: EnvironmentConfig,
        targetGroup: elbv2.ApplicationTargetGroup,
        certificate?: acm.ICertificate,
    ): void {
        if (certificate) {
            // 1. Always create the HTTPS listener if a certificate is available
            this.loadBalancer.addListener('HttpsListener', {
                port: 443,
                protocol: elbv2.ApplicationProtocol.HTTPS,
                certificates: [certificate],
                sslPolicy: this.getSslPolicy(config.loadBalancer.ssl?.sslPolicy),
                defaultTargetGroups: [targetGroup],
            });

            // 2. Now, decide what to do with the HTTP listener
            if (config.loadBalancer.ssl?.redirectHttpToHttps) {
                // If redirect is enabled (e.g., for production), create a redirecting listener
                this.loadBalancer.addListener('HttpRedirectListener', {
                    port: 80,
                    protocol: elbv2.ApplicationProtocol.HTTP,
                    defaultAction: elbv2.ListenerAction.redirect({
                        protocol: 'HTTPS',
                        port: '443',
                        permanent: true,
                    }),
                });
            } else {
                // If redirect is disabled (for dev/staging), create a standard listener that forwards traffic
                this.loadBalancer.addListener('HttpListener', {
                    port: 80,
                    protocol: elbv2.ApplicationProtocol.HTTP,
                    defaultTargetGroups: [targetGroup],
                });
            }
        } else {
            // Fallback: If no certificate, create only an HTTP listener (this part was already correct)
            this.loadBalancer.addListener('HttpListener', {
                port: 80,
                protocol: elbv2.ApplicationProtocol.HTTP,
                defaultTargetGroups: [targetGroup],
            });
        }
    }

    private getSslPolicy(customPolicy?: string): elbv2.SslPolicy {
        if (customPolicy) {
            switch (customPolicy) {
                case 'ELBSecurityPolicy-TLS-1-2-2017-01':
                    return elbv2.SslPolicy.TLS12;
                case 'ELBSecurityPolicy-TLS-1-2-Ext-2018-06':
                    return elbv2.SslPolicy.TLS12_EXT;
                case 'ELBSecurityPolicy-FS-1-2-Res-2020-10':
                    return elbv2.SslPolicy.FORWARD_SECRECY_TLS12_RES;
                default:
                    return elbv2.SslPolicy.RECOMMENDED_TLS;
            }
        }
        return elbv2.SslPolicy.RECOMMENDED_TLS;
    }

    private getImageUri(): string {
        // Priority order:
        // 1. Explicit context imageUri (for backwards compatibility)
        // 2. Context imageTag (new approach - build once, deploy everywhere)
        // 3. Fallback to latest tag for development

        const contextImageUri = this.node.tryGetContext('imageUri');
        if (contextImageUri) {
            return contextImageUri;
        }

        const contextImageTag = this.node.tryGetContext('imageTag');
        const ecrRegistry = `${this.account}.dkr.ecr.${this.region}.amazonaws.com`;
        const repository = 'balancer-api';

        if (contextImageTag) {
            return `${ecrRegistry}/${repository}:${contextImageTag}`;
        }

        // Fallback to latest tag for development convenience
        return `${ecrRegistry}/${repository}:latest`;
    }

    private exportLogGroupArns(config: EnvironmentConfig): void {
        // Export log group ARNs for log forwarder stack consumption
        new ssm.StringParameter(this, 'ApiLogGroupArn', {
            parameterName: `/v3-backend/${config.environment}/compute/apiLogGroupArn`,
            stringValue: this.apiLogGroup.logGroupArn,
            description: `API service log group ARN for ${config.environment}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'WorkerLogGroupArn', {
            parameterName: `/v3-backend/${config.environment}/compute/workerLogGroupArn`,
            stringValue: this.workerLogGroup.logGroupArn,
            description: `Worker service log group ARN for ${config.environment}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SchedulerLogGroupArn', {
            parameterName: `/v3-backend/${config.environment}/compute/schedulerLogGroupArn`,
            stringValue: this.schedulerLogGroup.logGroupArn,
            description: `Scheduler service log group ARN for ${config.environment}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'MigrationLogGroupArn', {
            parameterName: `/v3-backend/${config.environment}/compute/migrationLogGroupArn`,
            stringValue: this.migrationLogGroup.logGroupArn,
            description: `Migration task log group ARN for ${config.environment}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // Export ALB ARN for monitoring stack consumption
        new ssm.StringParameter(this, 'AlbArn', {
            parameterName: `/v3-backend/${config.environment}/compute/albArn`,
            stringValue: this.loadBalancer.loadBalancerArn,
            description: `Application Load Balancer ARN for ${config.environment}`,
            tier: ssm.ParameterTier.STANDARD,
        });
    }

    private createApiService(
        config: EnvironmentConfig,
        vpc: ec2.IVpc,
        securityGroup: ec2.ISecurityGroup,
        targetGroup: elbv2.ApplicationTargetGroup,
    ): ecs.FargateService {
        const service = new ecs.FargateService(this, 'ApiService', {
            serviceName: generateResourceName('api-service', config.environment),
            cluster: this.cluster,
            taskDefinition: this.apiTaskDefinition,
            desiredCount: config.autoScaling.minInstances,
            vpcSubnets: { subnets: vpc.privateSubnets },
            securityGroups: [securityGroup],
            enableExecuteCommand: config.environment !== 'production',
            // Enhanced deployment configuration based on environment
            ...this.getDeploymentConfig(config),
        });

        service.attachToApplicationTargetGroup(targetGroup);

        return service;
    }

    private createWorkerService(
        config: EnvironmentConfig,
        vpc: ec2.IVpc,
        securityGroup: ec2.ISecurityGroup,
    ): ecs.FargateService {
        return new ecs.FargateService(this, 'WorkerService', {
            serviceName: generateResourceName('worker-service', config.environment),
            cluster: this.cluster,
            taskDefinition: this.workerTaskDefinition,
            // Ensure only one worker instance at any time
            desiredCount: 1,
            vpcSubnets: { subnets: vpc.privateSubnets },
            securityGroups: [securityGroup],
            enableExecuteCommand: config.environment !== 'production',
            // Single-instance replacement strategy (allow 0 during transitions; no surge to keep a single worker)
            ...this.getWorkerDeploymentConfig(config),
        });
    }

    private createSchedulerService(
        config: EnvironmentConfig,
        vpc: ec2.IVpc,
        securityGroup: ec2.ISecurityGroup,
    ): ecs.FargateService {
        return new ecs.FargateService(this, 'SchedulerService', {
            serviceName: generateResourceName('scheduler-service', config.environment),
            cluster: this.cluster,
            taskDefinition: this.schedulerTaskDefinition,
            desiredCount: 1, // Always exactly 1 scheduler instance
            vpcSubnets: { subnets: vpc.privateSubnets },
            securityGroups: [securityGroup],
            enableExecuteCommand: config.environment !== 'production',
            // Special deployment config for single-instance scheduler
            ...this.getSchedulerDeploymentConfig(config),
        });
    }

    private configureApiAutoScaling(config: EnvironmentConfig): void {
        const scalableTarget = this.apiService.autoScaleTaskCount({
            minCapacity: config.autoScaling.minInstances,
            maxCapacity: config.autoScaling.maxInstances,
        });

        scalableTarget.scaleOnCpuUtilization('ApiCpuScaling', {
            targetUtilizationPercent: config.autoScaling.targetCpuUtilization,
            scaleInCooldown: cdk.Duration.seconds(config.autoScaling.scaleInCooldown),
            scaleOutCooldown: cdk.Duration.seconds(config.autoScaling.scaleOutCooldown),
        });

        scalableTarget.scaleOnMemoryUtilization('ApiMemoryScaling', {
            targetUtilizationPercent: config.autoScaling.targetMemoryUtilization,
            scaleInCooldown: cdk.Duration.seconds(config.autoScaling.scaleInCooldown),
            scaleOutCooldown: cdk.Duration.seconds(config.autoScaling.scaleOutCooldown),
        });
    }

    private configureWorkerAutoScaling(
        config: EnvironmentConfig,
        backgroundJobQueue: sqs.IQueue,
        dataRefreshQueue: sqs.IQueue,
        notificationQueue: sqs.IQueue,
    ): void {
        // Lock worker to a single instance; no autoscaling
        this.workerService.autoScaleTaskCount({
            minCapacity: 1,
            maxCapacity: 1,
        });
    }

    private configureSchedulerAutoScaling(config: EnvironmentConfig): void {
        // Scheduler doesn't need auto scaling - always 1 instance
        // But we can add CPU/memory monitoring for alerts
        const scalableTarget = this.schedulerService.autoScaleTaskCount({
            minCapacity: 1,
            maxCapacity: 1, // Fixed at 1 instance
        });

        // Optional: Add CloudWatch alarms for scheduler health monitoring
        // We could add CPU/memory alarms here in the future for operational monitoring
    }

    /**
     * Get deployment configuration based on environment
     * Production: Conservative, zero-downtime deployment
     * Staging: Balanced resilience and speed
     * Development: Fast deployment with basic resilience
     */
    private getDeploymentConfig(config: EnvironmentConfig): {
        healthCheckGracePeriod?: cdk.Duration;
        deploymentConfiguration?: any;
        circuitBreaker?: any;
    } {
        const isProduction = config.environment === 'production';
        const isStaging = config.environment === 'staging';

        if (isProduction) {
            return {
                // Production: Zero-downtime deployment with longer grace period
                healthCheckGracePeriod: cdk.Duration.seconds(900), // 15 min for production (allows slower startup under load)
                deploymentConfiguration: {
                    minimumHealthyPercent: 75,
                    maximumPercent: 200,
                },
                circuitBreaker: {
                    rollback: true,
                },
            };
        } else if (isStaging) {
            return {
                // Staging: Balanced deployment
                healthCheckGracePeriod: cdk.Duration.seconds(600), // 10 min for staging
                deploymentConfiguration: {
                    minimumHealthyPercent: 33,
                    maximumPercent: 200,
                },
                circuitBreaker: {
                    rollback: true,
                },
            };
        } else {
            return {
                // Development: Fast deployment with shorter grace period for quick iteration
                healthCheckGracePeriod: cdk.Duration.seconds(300), // 5 min for development (faster feedback)
                deploymentConfiguration: {
                    minimumHealthyPercent: 33, // Allow more headroom to start new tasks during partial outages
                    maximumPercent: 200,
                },
                circuitBreaker: {
                    rollback: true,
                },
            };
        }
    }

    /**
     * Special deployment configuration for scheduler service (single instance)
     */
    private getSchedulerDeploymentConfig(config: EnvironmentConfig): {
        healthCheckGracePeriod?: cdk.Duration;
        deploymentConfiguration?: any;
        circuitBreaker?: any;
    } {
        const isProduction = config.environment === 'production';

        return {
            // Scheduler: Single instance replacement strategy (allows 0% healthy for replacement)
            healthCheckGracePeriod: cdk.Duration.seconds(isProduction ? 900 : 600), // 15 min for production, 10 min for dev
            deploymentConfiguration: {
                minimumHealthyPercent: 0, // Allow full replacement for single instance
                maximumPercent: 200, // Allow surge instance during deployment
            },
            circuitBreaker: {
                rollback: config.environment === 'production', // Only auto-rollback in production
            },
        };
    }

    /**
     * Single-instance deployment configuration for worker service
     * - Allows 0% healthy during replacement
     * - Prevents surge to ensure only one worker runs at a time
     */
    private getWorkerDeploymentConfig(config: EnvironmentConfig): {
        healthCheckGracePeriod?: cdk.Duration;
        deploymentConfiguration?: any;
        circuitBreaker?: any;
    } {
        const isProduction = config.environment === 'production';

        return {
            healthCheckGracePeriod: cdk.Duration.seconds(isProduction ? 900 : 600),
            deploymentConfiguration: {
                minimumHealthyPercent: 0, // allow 0 during transition
                maximumPercent: 100, // no surge; keep single worker
            },
            circuitBreaker: {
                rollback: isProduction,
            },
        };
    }

    private applyTags(config: EnvironmentConfig): void {
        Object.entries(config.tags).forEach(([key, value]) => {
            cdk.Tags.of(this).add(key, value);
        });
        cdk.Tags.of(this).add('Stack', 'Compute');
    }

    private createOutputs(config: EnvironmentConfig): void {
        new cdk.CfnOutput(this, 'LoadBalancerDnsName', {
            value: this.loadBalancer.loadBalancerDnsName,
            description: 'DNS name of the Application Load Balancer',
            exportName: `${config.environment}-load-balancer-dns-name`,
        });
    }
}
