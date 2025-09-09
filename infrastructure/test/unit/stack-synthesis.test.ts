import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestApp } from '../helpers/test-utils';
import { EnvironmentName } from '../../config/shared/types';

describe('Stack Template Synthesis', () => {
    const environments: EnvironmentName[] = ['development', 'staging', 'production'];

    // Test that all stacks synthesize without errors for all environments
    test.each(environments)('%s environment - all stacks synthesize successfully', async (env) => {
        const testBundle = await createTestApp(env);

        // Each stack should synthesize without throwing errors
        expect(() => Template.fromStack(testBundle.networkingStack)).not.toThrow();
        expect(() => Template.fromStack(testBundle.s3Stack)).not.toThrow();
        expect(() => Template.fromStack(testBundle.sqsStack)).not.toThrow();
        expect(() => Template.fromStack(testBundle.databaseStack)).not.toThrow();
        expect(() => Template.fromStack(testBundle.computeStack)).not.toThrow();
        expect(() => Template.fromStack(testBundle.wafStack)).not.toThrow();
    });

    // Test that generated templates are valid CloudFormation
    test.each(environments)('%s environment - templates contain valid CloudFormation', async (env) => {
        const testBundle = await createTestApp(env);

        const networkingTemplate = Template.fromStack(testBundle.networkingStack);
        const s3Template = Template.fromStack(testBundle.s3Stack);
        const sqsTemplate = Template.fromStack(testBundle.sqsStack);
        const databaseTemplate = Template.fromStack(testBundle.databaseStack);
        const computeTemplate = Template.fromStack(testBundle.computeStack);
        const wafTemplate = Template.fromStack(testBundle.wafStack);

        // Templates should have required sections
        expect(networkingTemplate.toJSON()).toHaveProperty('Resources');
        expect(s3Template.toJSON()).toHaveProperty('Resources');
        expect(sqsTemplate.toJSON()).toHaveProperty('Resources');
        expect(databaseTemplate.toJSON()).toHaveProperty('Resources');
        expect(computeTemplate.toJSON()).toHaveProperty('Resources');
        expect(wafTemplate.toJSON()).toHaveProperty('Resources');

        // Templates should be objects with valid structure
        expect(typeof networkingTemplate.toJSON()).toBe('object');
        expect(typeof s3Template.toJSON()).toBe('object');
        expect(typeof sqsTemplate.toJSON()).toBe('object');
        expect(typeof databaseTemplate.toJSON()).toBe('object');
        expect(typeof computeTemplate.toJSON()).toBe('object');
        expect(typeof wafTemplate.toJSON()).toBe('object');
    });

    // Test database configuration - validates engine family compatibility
    test.each(environments)('%s environment - database stack has correct engine family', async (env) => {
        const testBundle = await createTestApp(env);
        const template = Template.fromStack(testBundle.databaseStack);

        // Should have RDS instance with PostgreSQL engine (version will be mapped to family)
        template.hasResourceProperties('AWS::RDS::DBInstance', {
            Engine: 'postgres',
        });

        // Database engine version should be a valid PostgreSQL version enum
        expect(testBundle.config.database.engineVersion).toBeDefined();
        expect(typeof testBundle.config.database.engineVersion).toBe('object');
        
        // Should be a PostgreSQL 15 or 16 version
        // Check if it's a valid enum value (CDK enums are strings internally)
        expect(testBundle.config.database.engineVersion).toContain('15');
    });

    // Test networking stack creates required resources
    test.each(environments)('%s environment - networking stack creates VPC and subnets', async (env) => {
        const testBundle = await createTestApp(env);
        const template = Template.fromStack(testBundle.networkingStack);

        // Should create VPC
        template.hasResourceProperties('AWS::EC2::VPC', {
            EnableDnsHostnames: true,
            EnableDnsSupport: true,
        });

        // Should create public and private subnets (3 AZs × 2 subnet types)
        template.resourceCountIs('AWS::EC2::Subnet', 6);

        // Should create Internet Gateway
        template.resourceCountIs('AWS::EC2::InternetGateway', 1);

        // Should create NAT Gateways (cost-optimized: 1 for dev/staging, 2 for prod)
        const expectedNatGateways = env === 'production' ? 2 : 1;
        template.resourceCountIs('AWS::EC2::NatGateway', expectedNatGateways);
    });

    // Test S3 stack creates buckets with proper encryption
    test.each(environments)('%s environment - S3 stack creates encrypted buckets', async (env) => {
        const testBundle = await createTestApp(env);
        const template = Template.fromStack(testBundle.s3Stack);

        // Should create S3 buckets (artifacts, logs, backups, assets)
        template.resourceCountIs('AWS::S3::Bucket', 4);

        // Should have KMS encryption configured (better than AES256)
        template.hasResourceProperties('AWS::S3::Bucket', {
            BucketEncryption: {
                ServerSideEncryptionConfiguration: [
                    {
                        ServerSideEncryptionByDefault: {
                            SSEAlgorithm: 'aws:kms',
                        },
                    },
                ],
            },
        });
    });

    // Test SQS stack creates queues with proper configuration
    test.each(environments)('%s environment - SQS stack creates queues with DLQs', async (env) => {
        const testBundle = await createTestApp(env);
        const template = Template.fromStack(testBundle.sqsStack);

        // Should create main queues and DLQs (3 main + 3 DLQ)
        template.resourceCountIs('AWS::SQS::Queue', 6);

        // Should have visibility timeout configured (CDK uses "VisibilityTimeout" property)
        template.hasResourceProperties('AWS::SQS::Queue', {
            VisibilityTimeout: testBundle.config.sqs.visibilityTimeoutSeconds,
        });
    });

    // Test compute stack creates ECS resources with proper configuration
    test.each(environments)('%s environment - compute stack creates ECS service and ALB', async (env) => {
        const testBundle = await createTestApp(env);
        const template = Template.fromStack(testBundle.computeStack);

        // Should create ECS cluster
        template.resourceCountIs('AWS::ECS::Cluster', 1);

        // Should create ECS services (API, Worker, and Scheduler)
        template.resourceCountIs('AWS::ECS::Service', 3);

        // Should create Application Load Balancer
        template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);

        // Should create target group with health check
        template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
            HealthCheckPath: testBundle.config.loadBalancer.healthCheckPath,
            HealthCheckIntervalSeconds: testBundle.config.loadBalancer.healthCheckInterval,
        });

        // Should create task definition with appropriate resource allocation
        // Note: Config already has CPU in CPU units (512 = 0.5 vCPU, 1024 = 1 vCPU)
        template.hasResourceProperties('AWS::ECS::TaskDefinition', {
            Cpu: testBundle.config.resources.cpu.toString(),
            Memory: testBundle.config.resources.memoryMiB.toString(),
        });
    });

    // Test WAF stack creates web ACL with rate limiting
    test.each(environments)('%s environment - WAF stack creates web ACL with security rules', async (env) => {
        const testBundle = await createTestApp(env);

        // Only test WAF if enabled for this environment
        if (testBundle.config.security.enableWaf) {
            const template = Template.fromStack(testBundle.wafStack);

            // Should create WAF WebACL
            template.resourceCountIs('AWS::WAFv2::WebACL', 1);

            // Should have GraphQL rate limiting rule among other security rules
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: Match.arrayWith([
                    Match.objectLike({
                        Name: 'GraphQLRateLimit',
                        Statement: {
                            RateBasedStatement: {
                                Limit: testBundle.config.security.wafRateLimit,
                            },
                        },
                    }),
                ]),
            });
        }
    });

    // Test security groups are properly used in ECS services
    test.each(environments)('%s environment - ECS services use security groups', async (env) => {
        const testBundle = await createTestApp(env);
        const template = Template.fromStack(testBundle.computeStack);

        // Should create ECS services that reference security groups
        template.hasResourceProperties('AWS::ECS::Service', {
            NetworkConfiguration: {
                AwsvpcConfiguration: {
                    SecurityGroups: Match.anyValue(),
                },
            },
        });

        // Should create Application Load Balancer that uses security groups
        template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
            SecurityGroups: Match.anyValue(),
        });
    });

    // Test auto-scaling configuration
    test.each(environments)('%s environment - auto-scaling is properly configured', async (env) => {
        const testBundle = await createTestApp(env);
        const template = Template.fromStack(testBundle.computeStack);

        // Should create auto-scaling targets (one per ECS service: API, Worker, and Scheduler)
        template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 3);

        // Should have CPU-based scaling policy
        template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
            TargetTrackingScalingPolicyConfiguration: {
                TargetValue: testBundle.config.autoScaling.targetCpuUtilization,
                PredefinedMetricSpecification: {
                    PredefinedMetricType: 'ECSServiceAverageCPUUtilization',
                },
            },
        });

        // Should have memory-based scaling policy
        template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
            TargetTrackingScalingPolicyConfiguration: {
                TargetValue: testBundle.config.autoScaling.targetMemoryUtilization,
                PredefinedMetricSpecification: {
                    PredefinedMetricType: 'ECSServiceAverageMemoryUtilization',
                },
            },
        });
    });

    // Test that production has stricter configurations than development
    test('Production has stricter resource configurations than development', async () => {
        const prodBundle = await createTestApp('production');
        const devBundle = await createTestApp('development');

        // Production should have higher resource allocations
        expect(prodBundle.config.resources.cpu).toBeGreaterThanOrEqual(devBundle.config.resources.cpu);
        expect(prodBundle.config.resources.memoryMiB).toBeGreaterThanOrEqual(devBundle.config.resources.memoryMiB);

        // Production should have higher auto-scaling limits
        expect(prodBundle.config.autoScaling.maxInstances).toBeGreaterThanOrEqual(
            devBundle.config.autoScaling.maxInstances,
        );

        // Production should have larger database
        expect(prodBundle.config.database.allocatedStorage).toBeGreaterThanOrEqual(
            devBundle.config.database.allocatedStorage,
        );
    });

    // Test environment-specific features
    test('Environment-specific features are correctly applied', async () => {
        const prodBundle = await createTestApp('production');
        const devBundle = await createTestApp('development');

        // Production should have WAF enabled
        expect(prodBundle.config.security.enableWaf).toBe(true);

        // Production should have deletion protection
        expect(prodBundle.config.database.deletionProtection).toBe(true);

        // Production should have multi-AZ
        expect(prodBundle.config.database.multiAz).toBe(true);

        // Development might have less strict settings
        expect(devBundle.config.database.deletionProtection).toBe(false);
    });

    // Test that all required tags are present
    test.each(environments)('%s environment - resources have required tags', async (env) => {
        const testBundle = await createTestApp(env);

        // Check that configuration has tags
        expect(testBundle.config.tags).toBeDefined();
        expect(testBundle.config.tags.Environment).toBe(env);
        expect(testBundle.config.tags.Project).toBeDefined();
    });
});
