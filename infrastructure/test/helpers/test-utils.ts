import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { EnvironmentConfig, EnvironmentName } from '../../config/shared/types';
import { loadEnvironmentConfig } from '../../config/environments/shared';
import { NetworkingStack } from '../../lib/stacks/networking-stack';
import { S3Stack } from '../../lib/stacks/s3-stack';
import { SqsStack } from '../../lib/stacks/sqs-stack';
import { DatabaseStack } from '../../lib/stacks/database-stack';
import { ComputeStack } from '../../lib/stacks/compute-stack';
import { WafStack } from '../../lib/stacks/waf-stack';
import { testConfig } from './test-setup';

export interface TestStackBundle {
    app: cdk.App;
    networkingStack: NetworkingStack;
    s3Stack: S3Stack;
    sqsStack: SqsStack;
    databaseStack: DatabaseStack;
    computeStack: ComputeStack;
    wafStack: WafStack;
    config: EnvironmentConfig;
}

/**
 * Create a complete test app with all stacks for testing
 */
export async function createTestApp(environment: EnvironmentName = 'development'): Promise<TestStackBundle> {
    const app = new cdk.App();
    const config = await loadEnvironmentConfig(environment);

    // Create networking stack
    const networkingStack = new NetworkingStack(app, `Test-Networking-${environment}`, {
        config,
        env: {
            account: testConfig.accountId,
            region: testConfig.region,
        },
    });

    // Create S3 stack
    const s3Stack = new S3Stack(app, `Test-S3-${environment}`, {
        config,
        env: {
            account: testConfig.accountId,
            region: testConfig.region,
        },
    });

    // Create SQS stack
    const sqsStack = new SqsStack(app, `Test-SQS-${environment}`, {
        config,
        env: {
            account: testConfig.accountId,
            region: testConfig.region,
        },
    });

    // Create security groups for testing
    const albSecurityGroup = new ec2.SecurityGroup(networkingStack, 'TestALBSecurityGroup', {
        vpc: networkingStack.vpc,
        description: 'Test ALB Security Group',
        allowAllOutbound: true,
    });

    const ecsSecurityGroup = new ec2.SecurityGroup(networkingStack, 'TestECSSecurityGroup', {
        vpc: networkingStack.vpc,
        description: 'Test ECS Security Group',
        allowAllOutbound: true,
    });

    const dbSecurityGroup = new ec2.SecurityGroup(networkingStack, 'TestDBSecurityGroup', {
        vpc: networkingStack.vpc,
        description: 'Test Database Security Group',
    });

    // Create database stack
    const databaseStack = new DatabaseStack(app, `Test-Database-${environment}`, {
        config,
        vpc: networkingStack.vpc,
        databaseSubnetGroup: networkingStack.databaseSubnetGroup,
        securityGroup: dbSecurityGroup,
        backupsBucket: s3Stack.backupsBucket,
        env: {
            account: testConfig.accountId,
            region: testConfig.region,
        },
    });

    // Create WAF stack
    const wafStack = new WafStack(app, `Test-WAF-${environment}`, {
        config,
        env: {
            account: testConfig.accountId,
            region: testConfig.region,
        },
    });

    // Create compute stack
    const computeStack = new ComputeStack(app, `Test-Compute-${environment}`, {
        config,
        vpc: networkingStack.vpc,
        albSecurityGroup,
        ecsSecurityGroup,
        database: databaseStack.database,
        queues: {
            backgroundJobQueue: sqsStack.backgroundJobQueue,
            dataRefreshQueue: sqsStack.dataRefreshQueue,
            notificationQueue: sqsStack.notificationQueue,
        },
        sqsEncryptionKeyArn: sqsStack.encryptionKey.keyArn,
        wafWebAclArn: wafStack.webAcl?.attrArn,
        env: {
            account: testConfig.accountId,
            region: testConfig.region,
        },
    });

    return {
        app,
        networkingStack,
        s3Stack,
        sqsStack,
        databaseStack,
        computeStack,
        wafStack,
        config,
    };
}

/**
 * Load environment configuration for testing
 */
export async function getTestConfig(environment: EnvironmentName): Promise<EnvironmentConfig> {
    return await loadEnvironmentConfig(environment);
}

/**
 * Create a simple test app with just one stack
 */
export async function createSimpleTestApp(
    stackClass: any,
    environment: EnvironmentName = 'development',
): Promise<{ app: cdk.App; stack: any; config: EnvironmentConfig }> {
    const app = new cdk.App();
    const config = await loadEnvironmentConfig(environment);

    const stack = new stackClass(app, `Test-${stackClass.name}-${environment}`, {
        config,
        env: {
            account: testConfig.accountId,
            region: testConfig.region,
        },
    });

    return { app, stack, config };
}
