import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/shared/types';
import { generateResourceName } from '../../config/environments/shared';

export interface S3StackProps extends cdk.StackProps {
    config: EnvironmentConfig;
}

/**
 * S3 Stack for Balancer v3 Backend
 *
 * Creates S3 buckets for various storage needs:
 * - Application artifacts (Docker images, deployment packages)
 * - Log archival (CloudWatch logs, ALB logs, application logs)
 * - Database backups and exports
 * - Static assets (if needed)
 * - CloudFormation templates and CDK assets
 */
export class S3Stack extends cdk.Stack {
    public readonly artifactsBucket: s3.Bucket;
    public readonly logsBucket: s3.Bucket;
    public readonly backupsBucket: s3.Bucket;
    public readonly assetsBucket: s3.Bucket;
    public readonly encryptionKey: kms.Key;

    constructor(scope: Construct, id: string, props: S3StackProps) {
        super(scope, id, props);

        const { config } = props;

        // Create KMS key for S3 encryption
        this.encryptionKey = this.createEncryptionKey(config);

        // Create S3 buckets
        this.artifactsBucket = this.createArtifactsBucket(config);
        this.logsBucket = this.createLogsBucket(config);
        this.backupsBucket = this.createBackupsBucket(config);
        this.assetsBucket = this.createAssetsBucket(config);

        // Apply tags
        this.applyTags(config);
    }

    /**
     * Create KMS key for S3 bucket encryption
     */
    private createEncryptionKey(config: EnvironmentConfig): kms.Key {
        const key = new kms.Key(this, 'S3EncryptionKey', {
            alias: `alias/${generateResourceName('s3-encryption', config.environment)}`,
            description: `S3 encryption key for Balancer v3 Backend ${config.environment} environment`,
            enableKeyRotation: true,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        // Allow S3 service to use the key
        key.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
                actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
                resources: ['*'],
                conditions: {
                    StringEquals: {
                        'kms:via': 's3.amazonaws.com',
                    },
                },
            }),
        );

        // Allow CloudWatch Logs to use the key
        key.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
                actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
                resources: ['*'],
                conditions: {
                    ArnEquals: {
                        'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:/v3-backend/${config.environment}/*`,
                    },
                },
            }),
        );

        return key;
    }

    /**
     * Get allowed CORS origins based on environment
     */
    private getAllowedCorsOrigins(config: EnvironmentConfig): string[] {
        // Environment-specific domain allowlists
        const allowedOrigins: Record<string, string[]> = {
            development: [
                'http://localhost:3000',
                'http://localhost:4000',
                'http://127.0.0.1:3000',
                'http://127.0.0.1:4000',
                'https://dev.balancer.fi',
                'https://dev-api.balancer.fi',
            ],
            staging: ['https://staging.balancer.fi', 'https://staging-api.balancer.fi', 'https://test.balancer.fi'],
            production: [
                'https://balancer.fi',
                'https://app.balancer.fi',
                'https://api.balancer.fi',
                'https://beethoven-x.io',
                'https://beets.fi',
            ],
        };

        return allowedOrigins[config.environment] || allowedOrigins.development;
    }

    /**
     * Create artifacts bucket for application deployments
     */
    private createArtifactsBucket(config: EnvironmentConfig): s3.Bucket {
        const bucket = new s3.Bucket(this, 'ArtifactsBucket', {
            bucketName: generateResourceName('artifacts', config.environment),
            versioned: true,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: this.encryptionKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: config.environment !== 'production',
            lifecycleRules: [
                {
                    id: 'ArtifactRetention',
                    enabled: true,
                    expiration: cdk.Duration.days(config.environment === 'production' ? 365 : 90),
                    noncurrentVersionExpiration: cdk.Duration.days(30),
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
                },
                {
                    id: 'TransitionToIA',
                    enabled: true,
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                            transitionAfter: cdk.Duration.days(30),
                        },
                        {
                            storageClass: s3.StorageClass.GLACIER,
                            transitionAfter: cdk.Duration.days(90),
                        },
                    ],
                },
            ],
            eventBridgeEnabled: true,
        });

        // Add CORS configuration for potential web uploads with restricted origins
        bucket.addCorsRule({
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
            allowedOrigins: this.getAllowedCorsOrigins(config),
            allowedHeaders: ['Content-Type', 'Content-Length', 'Authorization', 'X-Amz-*'],
            exposedHeaders: ['ETag', 'x-amz-version-id'],
            maxAge: 3000,
        });

        return bucket;
    }

    /**
     * Create logs bucket for log archival
     */
    private createLogsBucket(config: EnvironmentConfig): s3.Bucket {
        const bucket = new s3.Bucket(this, 'LogsBucket', {
            bucketName: generateResourceName('logs', config.environment),
            versioned: false, // Logs don't typically need versioning
            // ALB access logs do NOT support KMS. Use S3-managed AES-256 encryption.
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: config.environment !== 'production',
            lifecycleRules: [
                {
                    id: 'LogRetention',
                    enabled: true,
                    expiration: cdk.Duration.days(config.environment === 'production' ? 2555 : 365), // 7 years for production, 1 year for others
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
                },
                {
                    id: 'LogTransitions',
                    enabled: true,
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                            transitionAfter: cdk.Duration.days(30),
                        },
                        {
                            storageClass: s3.StorageClass.GLACIER,
                            transitionAfter: cdk.Duration.days(90),
                        },
                        {
                            storageClass: s3.StorageClass.DEEP_ARCHIVE,
                            transitionAfter: cdk.Duration.days(365),
                        },
                    ],
                },
            ],
            eventBridgeEnabled: true,
        });

        // Allow ALB to write access logs
        bucket.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal('elasticloadbalancing.amazonaws.com')],
                actions: ['s3:PutObject'],
                resources: [`${bucket.bucketArn}/alb-logs/*`],
            }),
        );

        // Allow CloudWatch Logs to access bucket ACL
        bucket.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
                actions: ['s3:GetBucketAcl'],
                resources: [bucket.bucketArn],
            }),
        );

        // Allow CloudWatch Logs to put objects with proper ACL
        bucket.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
                actions: ['s3:PutObject'],
                resources: [`${bucket.bucketArn}/cloudwatch-exports/*`],
                conditions: {
                    StringEquals: {
                        's3:x-amz-acl': 'bucket-owner-full-control',
                    },
                },
            }),
        );

        return bucket;
    }

    /**
     * Create backups bucket for database and application backups
     */
    private createBackupsBucket(config: EnvironmentConfig): s3.Bucket {
        const bucket = new s3.Bucket(this, 'BackupsBucket', {
            bucketName: generateResourceName('backups', config.environment),
            versioned: true,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: this.encryptionKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: config.environment !== 'production', // Auto-delete for non-production
            lifecycleRules: [
                {
                    id: 'BackupRetention',
                    enabled: true,
                    expiration: cdk.Duration.days(config.environment === 'production' ? 2555 : 1095), // 7 years for production, 3 years for others
                    noncurrentVersionExpiration: cdk.Duration.days(90),
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
                },
                {
                    id: 'BackupTransitions',
                    enabled: true,
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                            transitionAfter: cdk.Duration.days(30),
                        },
                        {
                            storageClass: s3.StorageClass.GLACIER,
                            transitionAfter: cdk.Duration.days(90),
                        },
                        {
                            storageClass: s3.StorageClass.DEEP_ARCHIVE,
                            transitionAfter: cdk.Duration.days(365),
                        },
                    ],
                },
            ],
            eventBridgeEnabled: true,
        });

        // Cross-region replication for production backups
        if (config.environment === 'production') {
            // Create replication role
            const replicationRole = new iam.Role(this, 'BackupReplicationRole', {
                assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
                inlinePolicies: {
                    ReplicationPolicy: new iam.PolicyDocument({
                        statements: [
                            new iam.PolicyStatement({
                                effect: iam.Effect.ALLOW,
                                actions: ['s3:GetObjectVersionForReplication', 's3:GetObjectVersionAcl'],
                                resources: [`${bucket.bucketArn}/*`],
                            }),
                            new iam.PolicyStatement({
                                effect: iam.Effect.ALLOW,
                                actions: ['s3:ReplicateObject', 's3:ReplicateDelete'],
                                resources: [
                                    `arn:aws:s3:::${generateResourceName('backups-replica', config.environment)}/*`,
                                ],
                            }),
                        ],
                    }),
                },
            });

            // Add replication configuration (destination bucket would need to be created separately)
            bucket.addToResourcePolicy(
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    principals: [replicationRole],
                    actions: ['s3:GetObjectVersionForReplication', 's3:GetObjectVersionAcl'],
                    resources: [`${bucket.bucketArn}/*`],
                }),
            );
        }

        return bucket;
    }

    /**
     * Create assets bucket for static assets
     */
    private createAssetsBucket(config: EnvironmentConfig): s3.Bucket {
        const bucket = new s3.Bucket(this, 'AssetsBucket', {
            bucketName: generateResourceName('assets', config.environment),
            versioned: false,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: this.encryptionKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: config.environment !== 'production',
            lifecycleRules: [
                {
                    id: 'AssetRetention',
                    enabled: true,
                    expiration: cdk.Duration.days(config.environment === 'production' ? 1095 : 365), // 3 years for production, 1 year for others
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
                },
                {
                    id: 'AssetTransitions',
                    enabled: true,
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                            transitionAfter: cdk.Duration.days(60),
                        },
                    ],
                },
            ],
            eventBridgeEnabled: true,
        });

        // Add CORS configuration for web access with restricted origins
        bucket.addCorsRule({
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
            allowedOrigins: this.getAllowedCorsOrigins(config),
            allowedHeaders: ['Content-Type', 'Content-Length', 'Authorization', 'Range'],
            exposedHeaders: ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified'],
            maxAge: 86400, // 24 hours
        });

        return bucket;
    }

    /**
     * Apply consistent tags to all resources
     */
    private applyTags(config: EnvironmentConfig): void {
        const resources = [
            this.artifactsBucket,
            this.logsBucket,
            this.backupsBucket,
            this.assetsBucket,
            this.encryptionKey,
        ];

        resources.forEach((resource) => {
            Object.entries(config.tags).forEach(([key, value]) => {
                cdk.Tags.of(resource).add(key, value);
            });
            cdk.Tags.of(resource).add('Stack', 'S3');
        });
    }
}
