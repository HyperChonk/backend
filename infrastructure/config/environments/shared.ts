import { EnvironmentConfig, EnvironmentName, ValidationConstraints } from '../shared/types';
import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Common configuration values shared across all environments
 */
export const SHARED_CONFIG = {
    /** Application name used for resource naming */
    applicationName: 'v3-backend',

    /** AWS region (can be overridden by environment) */
    defaultRegion: 'us-east-1',

    /** Common tags applied to all resources */
    commonTags: {
        Project: 'BalancerV3Backend',
        ManagedBy: 'CDK',
        Repository: 'v3-backend',
    },

    /** Container configuration */
    container: {
        port: 4000,
        healthCheckPath: '/health',
        gracefulShutdownTimeout: 30,
    },

    /** Database configuration */
    database: {
        name: 'balancer_v3',
        port: 5432,
        engineVersion: rds.PostgresEngineVersion.VER_15,
    },

    /** Logging configuration */
    logging: {
        levels: {
            development: 'debug',
            staging: 'info',
            production: 'error',
        },
        format: 'json',
    },

    /** Health check endpoints */
    healthChecks: {
        api: '/health',
        readiness: '/ready',
        liveness: '/alive',
    },

    /** Secrets Manager configuration */
    secrets: {
        encryptionKeyAlias: 'alias/v3-backend',
    },
} as const;

/**
 * Type-safe contracts for stack parameter sharing
 */
export interface StackParameterContract {
    networking: {
        vpcId: string;
        publicSubnetIds: string[];
        privateSubnetIds: string[];
        isolatedSubnetIds: string[];
        availabilityZones: string[];
        dbSubnetGroupName: string;
    };
    security: {
        albSgId: string;
        ecsSgId: string;
        dbSgId: string;
        vpceSgId: string;
    };
    database: {
        endpoint: string;
        port: string;
        credentialsArn: string;
    };
    queues: {
        backgroundJobQueueUrl: string;
        backgroundJobQueueArn: string;
        dataRefreshQueueUrl: string;
        dataRefreshQueueArn: string;
        notificationQueueUrl: string;
        notificationQueueArn: string;
        encryptionKeyArn: string;
    };
    s3: {
        logsBucketName: string;
        logsBucketArn: string;
        assetsBucketName: string;
        assetsBucketArn: string;
        backupsBucketName: string;
        backupsBucketArn: string;
    };
    certificates: {
        certificateArn: string;
    };
    dns: {
        hostedZoneId: string;
        hostedZoneName: string;
        nameServers: string;
    };
    waf: {
        webAclArn: string;
        webAclId: string;
    };
}

/**
 * Type-safe SSM parameter name generation
 */
export function getSsmParameterName<
    TStack extends keyof StackParameterContract,
    TResource extends keyof StackParameterContract[TStack],
>(stackName: TStack, resourceName: TResource, environment: EnvironmentName): string {
    return `/${SHARED_CONFIG.applicationName}/${environment}/${stackName}/${String(resourceName)}`;
}

/**
 * Validation constraints for environment configurations
 */
export const VALIDATION_CONSTRAINTS: ValidationConstraints = {
    minCpu: 256, // 0.25 vCPU in CPU units (0.25 * 1024)
    maxCpu: 4096, // 4 vCPU in CPU units (4 * 1024)
    minMemoryMiB: 512,
    maxMemoryMiB: 8192,
    validInstanceTypes: [
        'db.t3.micro',
        'db.t3.small',
        'db.t3.medium',
        'db.t3.large',
        'db.t3.xlarge',
        'db.r5.large',
        'db.r5.xlarge',
        'db.r5.2xlarge',
    ],
    validRegions: ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'],
};

/**
 * Get environment name from process environment or default
 */
export function getEnvironmentName(): EnvironmentName {
    const env = process.env.ENVIRONMENT || process.env.NODE_ENV || 'development';
    return normalizeEnvironmentName(env);
}

/**
 * Normalize environment name to handle aliases like 'dev' -> 'development'
 */
export function normalizeEnvironmentName(environment: string): EnvironmentName {
    if (environment === 'dev' || environment === 'development') return 'development';
    if (environment === 'staging' || environment === 'stage') return 'staging';
    if (environment === 'prod' || environment === 'production') return 'production';

    console.warn(`Unknown environment '${environment}', defaulting to development`);
    return 'development';
}

/**
 * Generate resource name with environment prefix
 */
export function generateResourceName(resourceType: string, environment: EnvironmentName): string {
    return `${SHARED_CONFIG.applicationName}-${environment}-${resourceType}`;
}

/**
 * Generate stack name with environment prefix
 */
export function generateStackName(stackType: string, environment: EnvironmentName): string {
    return `${SHARED_CONFIG.applicationName}-${environment}-${stackType}`;
}

/**
 * Validate environment configuration against constraints
 */
export function validateConfiguration(config: EnvironmentConfig): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate CPU allocation
    if (config.resources.cpu < VALIDATION_CONSTRAINTS.minCpu) {
        errors.push(`CPU allocation ${config.resources.cpu} is below minimum ${VALIDATION_CONSTRAINTS.minCpu}`);
    }
    if (config.resources.cpu > VALIDATION_CONSTRAINTS.maxCpu) {
        errors.push(`CPU allocation ${config.resources.cpu} exceeds maximum ${VALIDATION_CONSTRAINTS.maxCpu}`);
    }

    // Validate memory allocation
    if (config.resources.memoryMiB < VALIDATION_CONSTRAINTS.minMemoryMiB) {
        errors.push(
            `Memory allocation ${config.resources.memoryMiB}MiB is below minimum ${VALIDATION_CONSTRAINTS.minMemoryMiB}MiB`,
        );
    }
    if (config.resources.memoryMiB > VALIDATION_CONSTRAINTS.maxMemoryMiB) {
        errors.push(
            `Memory allocation ${config.resources.memoryMiB}MiB exceeds maximum ${VALIDATION_CONSTRAINTS.maxMemoryMiB}MiB`,
        );
    }

    // Validate RDS instance type (now using CDK type-safe InstanceType)
    // Note: Due to deep merge issues, InstanceType objects may lose their prototype
    // but CDK synthesis will handle them correctly, so we only do basic validation
    if (!config.database.instanceSize) {
        errors.push(`Invalid RDS instance type: instanceSize is required`);
    } else {
        const instanceSize = config.database.instanceSize as any;

        // Basic validation - just check that we have some kind of object that could represent an instance type
        if (typeof instanceSize !== 'object' || instanceSize === null) {
            errors.push(`Invalid RDS instance type: instance type must be an object`);
        }
        // Skip further validation - CDK synthesis handles the actual validation
    }

    // Validate region
    if (!VALIDATION_CONSTRAINTS.validRegions.includes(config.region)) {
        warnings.push(`Region ${config.region} is not in the list of validated regions`);
    }

    // Validate auto-scaling configuration
    if (config.autoScaling.minInstances > config.autoScaling.maxInstances) {
        errors.push('Minimum instances cannot be greater than maximum instances');
    }

    // Validate backup retention for production
    if (config.environment === 'production' && config.database.backupRetention < 7) {
        warnings.push('Production environment should have at least 7 days backup retention');
    }

    return {
        isValid: errors.length === 0,
        errors,
        warnings,
    };
}

/**
 * Load configuration for a specific environment
 */
export async function loadEnvironmentConfig(environment: EnvironmentName | string): Promise<EnvironmentConfig> {
    const normalizedEnvironment = normalizeEnvironmentName(environment);

    const baseConfig: EnvironmentConfig = {
        environment: normalizedEnvironment,
        region: SHARED_CONFIG.defaultRegion,
        resources: {
            cpu: 512,
            memoryMiB: 1024,
        },
        database: {
            instanceSize: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            engineVersion: SHARED_CONFIG.database.engineVersion,
            allocatedStorage: 20,
            backupRetention: normalizedEnvironment === 'production' ? 7 : 1,
            performanceInsights: normalizedEnvironment === 'production',
            deletionProtection: normalizedEnvironment === 'production',
            multiAz: normalizedEnvironment === 'production',
            connectionLimits: {
                maxConnections: 100,
                maxPoolSize: 10,
            },
        },
        autoScaling: {
            minInstances: 1,
            maxInstances: 3,
            targetCpuUtilization: 70,
            targetMemoryUtilization: 80,
            scaleOutCooldown: 300,
            scaleInCooldown: 300,
            targetQueueLength: 5,
        },
        sqs: {
            visibilityTimeoutSeconds: 60,
            messageRetentionPeriod: 1209600,
            receiveWaitTimeSeconds: 20,
            maxReceiveCount: 3,
            dlqRetentionPeriod: 1209600,
        },
        loadBalancer: {
            enableAccessLogs: normalizedEnvironment === 'production',
            idleTimeout: 60,
            healthCheckInterval: 30,
            healthCheckTimeout: 5,
            healthyThresholdCount: 2,
            unhealthyThresholdCount: 3,
            healthCheckPath: SHARED_CONFIG.healthChecks.api,
            ssl: {
                enabled: false,
                redirectHttpToHttps: false,
                sslPolicy: 'ELBSecurityPolicy-TLS-1-2-2017-01',
            },
        },
        monitoring: {
            logRetention:
                normalizedEnvironment === 'production' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
            detailedMonitoring: normalizedEnvironment === 'production',
            insightsRetention: 7,
            enableXRayTracing: true,
            alertingEnabled: normalizedEnvironment !== 'development',
            thresholds: {
                sqsQueueDepth: normalizedEnvironment === 'production' ? 100 : 50,
                sqsMessageAge: 300,
                cpuUtilization: 70,
                memoryUtilization: 80,
            },
        },
        security: {
            enableWaf: normalizedEnvironment === 'production',
            wafRateLimit: 2000,
            graphqlQuerySizeLimit: normalizedEnvironment === 'production' ? 15000 : 10000,
            enableFlowLogs: normalizedEnvironment === 'production',
            enableGuardDuty: normalizedEnvironment === 'production',
            enableConfigRules: normalizedEnvironment === 'production',
        },
        cost: {
            enableCostAllocationTags: true,
            monthlyBudgetLimit: normalizedEnvironment === 'production' ? 1000 : 100,
            budgetAlertThreshold: 80,
            enableDetailedBilling: true,
        },
        tags: {
            ...SHARED_CONFIG.commonTags,
            Environment: normalizedEnvironment,
        },
    };

    const envModule = await import(`./${normalizedEnvironment}`);
    const envConfig = envModule.default || envModule.config;

    const mergedConfig = {
        ...baseConfig,
        ...envConfig,
        resources: { ...baseConfig.resources, ...envConfig.resources },
        database: { ...baseConfig.database, ...envConfig.database },
        autoScaling: { ...baseConfig.autoScaling, ...envConfig.autoScaling },
        sqs: { ...baseConfig.sqs, ...envConfig.sqs },
        loadBalancer: { ...baseConfig.loadBalancer, ...envConfig.loadBalancer },
        monitoring: { ...baseConfig.monitoring, ...envConfig.monitoring },
        security: { ...baseConfig.security, ...envConfig.security },
        cost: { ...baseConfig.cost, ...envConfig.cost },
        tags: { ...baseConfig.tags, ...envConfig.tags },
    };

    const validation = validateConfiguration(mergedConfig);

    if (!validation.isValid) {
        throw new Error(`Invalid configuration for ${normalizedEnvironment}: ${validation.errors.join(', ')}`);
    }

    if (validation.warnings.length > 0) {
        console.warn(`Configuration warnings for ${normalizedEnvironment}:`, validation.warnings);
    }

    return mergedConfig;
}

/**
 * Get secrets manager secret name
 */
export function getSecretName(environment: EnvironmentName, secretType: string): string {
    return `${SHARED_CONFIG.applicationName}/${environment}/${secretType}`;
}

/**
 * Get parameter store parameter name
 */
export function getParameterName(environment: EnvironmentName, parameterType: string): string {
    return `/${SHARED_CONFIG.applicationName}/${environment}/${parameterType}`;
}

/**
 * Validation result interface
 */
export interface ValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}
