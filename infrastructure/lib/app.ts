#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkingStack } from './stacks/networking-stack';
import { SecurityStack } from './stacks/security-stack';
import { SecretsStack } from './stacks/secrets-stack';
import { DatabaseStack } from './stacks/database-stack';
import { SqsStack } from './stacks/sqs-stack';
import { S3Stack } from './stacks/s3-stack';
import { WafStack } from './stacks/waf-stack';
import { CertificateStack } from './stacks/certificate-stack';
import { HostedZoneStack } from './stacks/hosted-zone-stack';
import { ComputeStack } from './stacks/compute-stack';
import { MonitoringStack } from './stacks/monitoring-stack';
import { LogForwarderStack } from './stacks/log-forwarder-stack';
import {
    getEnvironmentName,
    loadEnvironmentConfig,
    generateStackName,
    getSsmParameterName,
    normalizeEnvironmentName,
} from '../config/environments/shared';
import * as logs from 'aws-cdk-lib/aws-logs';

async function main() {
    const app = new cdk.App();

    // Get environment from context or environment variable
    const rawEnvironmentName = app.node.tryGetContext('environment') || getEnvironmentName();

    // Normalize the environment name to handle 'dev' -> 'development' etc.
    const environmentName = normalizeEnvironmentName(rawEnvironmentName);

    // Load environment configuration
    const config = await loadEnvironmentConfig(environmentName);

    console.log(`Deploying to ${environmentName} environment`);
    console.log(`Region: ${config.region}`);

    // Common stack props
    const stackProps = {
        env: {
            account: process.env.CDK_DEFAULT_ACCOUNT,
            region: config.region,
        },
        config,
    };

    // Foundation stacks - these produce SSM parameters
    const networkingStack = new NetworkingStack(app, generateStackName('networking', config.environment), stackProps);

    const securityStack = new SecurityStack(app, generateStackName('security', config.environment), {
        ...stackProps,
        vpc: networkingStack.vpc,
    });

    // Independent service stacks
    const sqsStack = new SqsStack(app, generateStackName('sqs', config.environment), stackProps);

    // Create S3 Stack
    const s3Stack = new S3Stack(app, generateStackName('s3', config.environment), stackProps);

    const secretsStack = new SecretsStack(app, generateStackName('secrets', config.environment), stackProps);

    let wafStack: WafStack | undefined;
    if (config.security.enableWaf) {
        wafStack = new WafStack(app, generateStackName('waf', config.environment), stackProps);
    }

    // Consumer stacks - these look up SSM parameters
    const databaseStack = new DatabaseStack(app, generateStackName('database', config.environment), {
        ...stackProps,
        vpc: networkingStack.vpc,
        securityGroup: securityStack.securityGroups.databaseSecurityGroup,
        backupsBucket: s3Stack.backupsBucket,
        databaseSubnetGroup: networkingStack.databaseSubnetGroup,
    });

    let hostedZoneStack: HostedZoneStack | undefined;
    let certificateStack: CertificateStack | undefined;

    // Check if SSL is enabled and has a domain configured
    if (config.loadBalancer.ssl?.enabled) {
        // If a domain is configured, a Hosted Zone is required for DNS validation.
        if (!config.loadBalancer.ssl.rootDomain) {
            throw new Error(
                'rootDomain must be configured in environment config when domainName is specified for SSL.',
            );
        }

        hostedZoneStack = new HostedZoneStack(app, generateStackName('hosted-zone', config.environment), {
            ...stackProps,
            domainName: config.loadBalancer.ssl.rootDomain,
        });

        // The CertificateStack now requires the hosted zone from the HostedZoneStack.
        certificateStack = new CertificateStack(app, generateStackName('certificate', config.environment), {
            ...stackProps,
            config: config,
            domainName: config.loadBalancer.ssl.domainName,
            hostedZone: hostedZoneStack.hostedZone,
        });

        certificateStack.addDependency(hostedZoneStack);
    }

    // ComputeStack now uses direct construct references
    const computeStack = new ComputeStack(app, generateStackName('compute', config.environment), {
        ...stackProps,
        vpc: networkingStack.vpc,
        albSecurityGroup: securityStack.securityGroups.albSecurityGroup,
        ecsSecurityGroup: securityStack.securityGroups.ecsSecurityGroup,
        database: databaseStack.database,
        queues: {
            backgroundJobQueue: sqsStack.backgroundJobQueue,
            dataRefreshQueue: sqsStack.dataRefreshQueue,
            notificationQueue: sqsStack.notificationQueue,
        },
        sqsEncryptionKeyArn: sqsStack.encryptionKey.keyArn,
        wafWebAclArn: wafStack?.webAcl?.attrArn,
        certificate: certificateStack?.certificate,
        hostedZone: hostedZoneStack?.hostedZone,
        logsBucket: s3Stack.logsBucket,
        // ECR repository is managed separately via shared ECR stack
    });

    // MonitoringStack now uses lookups for infrastructure to support stack separation
    const monitoringStack = new MonitoringStack(app, generateStackName('monitoring', config.environment), {
        ...stackProps,
        config,
        // Use lookups instead of direct references for separated stacks
        clusterName: `v3-backend-${config.environment}-cluster`,
        // Removed direct loadBalancerArn reference - monitoring stack will look it up from SSM
        database: databaseStack.database,
        backgroundJobQueue: sqsStack.backgroundJobQueue,
        dataRefreshQueue: sqsStack.dataRefreshQueue,
        notificationQueue: sqsStack.notificationQueue,
        serviceNamePrefix: `v3-backend-${config.environment}`,
        wafWebAclName: wafStack?.webAcl?.attrId,
        alertEmail: process.env.ALERT_EMAIL,
    });

    // For now, keep direct references until compute stack is deployed with SSM parameters
    // TODO: Switch to SSM parameter lookups after first deployment
    const logForwarderStack = new LogForwarderStack(app, generateStackName('log-forwarder', config.environment), {
        ...stackProps,
        config,
        logGroupArns: [
            // Use direct references for initial deployment
            computeStack.apiLogGroup.logGroupArn,
            computeStack.workerLogGroup.logGroupArn,
            computeStack.schedulerLogGroup.logGroupArn,
            computeStack.migrationLogGroup.logGroupArn,
            // Keep direct references for non-compute stacks
            wafStack?.logGroup?.logGroupArn,
            networkingStack.flowLogGroup?.logGroupArn,
        ].filter((arn): arn is string => !!arn),
    });

    // With direct construct passing, CDK automatically creates the dependency graph
    // We only need to add explicit dependencies for conditional resources
    if (certificateStack) {
        computeStack.addDependency(certificateStack);
    }

    // Monitoring stack already uses direct references, but we can be explicit
    monitoringStack.addDependency(computeStack);
    monitoringStack.addDependency(databaseStack);
    monitoringStack.addDependency(sqsStack);
    if (wafStack) {
        monitoringStack.addDependency(wafStack);
    }

    // LogForwarder depends on the log groups from other stacks
    logForwarderStack.addDependency(computeStack);
    if (wafStack) {
        logForwarderStack.addDependency(wafStack);
    }
    logForwarderStack.addDependency(networkingStack);

    // Add global tags
    Object.entries(config.tags).forEach(([key, value]) => {
        cdk.Tags.of(app).add(key, value);
    });

    // Add environment-specific tags
    cdk.Tags.of(app).add('Project', 'BalancerV3Backend');
    cdk.Tags.of(app).add('Environment', config.environment);
    cdk.Tags.of(app).add('ManagedBy', 'CDK');
}

main().catch((error) => {
    console.error('Error initializing CDK app:', error);
    process.exit(1);
});
