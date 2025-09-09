import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { EnvironmentConfig } from '../shared/types';

/**
 * Staging environment configuration
 * Optimized for testing and QA with moderate resource allocation and production-like features
 */
const stagingConfig: Partial<EnvironmentConfig> = {
    environment: 'staging',
    region: 'us-east-1',

    // Reduced resource allocation for staging cost optimization (matching development)
    resources: {
        cpu: 512, // 0.5 vCPU in CPU units (0.5 * 1024) - same as dev
        memoryMiB: 1024, // 1GB - same as dev
    },

    // Staging database configuration - cost optimized (matching development)
    database: {
        instanceSize: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
        engineVersion: rds.PostgresEngineVersion.VER_15,
        allocatedStorage: 50, // Keep current - cannot be reduced
        maxAllocatedStorage: 100, // Must be >= allocatedStorage for RDS autoscaling
        backupRetention: 1, // Minimal backup retention like dev
        performanceInsights: false,
        deletionProtection: false, // Allow easy cleanup
        multiAz: false, // Single AZ for cost savings
        connectionLimits: {
            maxConnections: 25, // Reduced to match dev
            maxPoolSize: 3, // Reduced to match dev
        },
    },

    // Cost-effective auto-scaling for staging (matching development)
    autoScaling: {
        minInstances: 1, // Minimum 1 for availability like dev
        maxInstances: 3, // Reduced from 5 to match dev
        targetCpuUtilization: 70, // Lower threshold for better responsiveness
        targetMemoryUtilization: 80,
        scaleOutCooldown: 300, // Faster scale-out like dev
        scaleInCooldown: 600, // Moderate scale-in
        targetQueueLength: 10, // Match dev
        // Enhanced deployment resilience
        deploymentResilience: {
            minHealthyDuringUpdate: 1, // Always keep 1 instance healthy
            maxUnavailableDuringUpdate: 0, // Zero downtime during updates like dev
            healthCheckGracePeriod: 300, // 5 min grace period
            rollbackOnFailure: true,
        },
    },

    // Staging SQS configuration (matching development)
    sqs: {
        visibilityTimeoutSeconds: 30, // Match dev
        messageRetentionPeriod: 345600, // 4 days (shorter like dev)
        receiveWaitTimeSeconds: 10, // Match dev
        maxReceiveCount: 2, // Match dev
        dlqRetentionPeriod: 345600, // 4 days like dev
    },

    // Staging load balancer configuration (matching development)
    loadBalancer: {
        enableAccessLogs: true, // Enable to test ALB access logs pre-prod
        idleTimeout: 60,
        healthCheckInterval: 30, // More frequent checks for faster feedback
        healthCheckTimeout: 15, // Longer timeout like dev
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5, // More lenient failure tolerance like dev
        healthCheckPath: '/health',
        ssl: {
            enabled: true, // Enable SSL for staging
            redirectHttpToHttps: false, // Keep both HTTP and HTTPS available
            sslPolicy: 'ELBSecurityPolicy-TLS-1-2-2017-01',
            domainName: 'staging-api.hyperchonk.com', // Staging subdomain
            rootDomain: 'hyperchonk.com', // Root domain for Route53 hosted zone
        },
    },

    // Staging monitoring configuration (matching development)
    monitoring: {
        logRetention: logs.RetentionDays.THREE_DAYS, // Shorter log retention like dev
        detailedMonitoring: false, // Disable like dev
        insightsRetention: 1, // Match dev
        enableXRayTracing: false, // Disable for cost savings like dev
        alertingEnabled: false, // No alerts like dev
        thresholds: {
            sqsQueueDepth: 20, // Lower threshold like dev
            sqsMessageAge: 600, // 10 minutes - more relaxed like dev
            cpuUtilization: 85, // Higher threshold like dev
            memoryUtilization: 90, // Higher threshold like dev
        },
    },

    // Minimal security for staging (matching development)
    security: {
        enableWaf: false, // Disable WAF like dev
        wafRateLimit: 1000, // Match dev
        graphqlQuerySizeLimit: 8000, // 8KB - smaller like dev
        enableFlowLogs: false, // Enable for log forwarding testing
        enableGuardDuty: false,
        enableConfigRules: false,
    },

    // Staging cost configuration (matching development)
    cost: {
        enableCostAllocationTags: true,
        monthlyBudgetLimit: 50, // Low budget like development
        budgetAlertThreshold: 75, // Match dev
        enableDetailedBilling: false, // Simplified billing like dev
    },

    // Staging-specific tags
    tags: {
        Environment: 'staging',
        Owner: 'QA Team',
        CostCenter: 'Testing',
        AutoShutdown: 'false', // Keep running for testing
        DataClassification: 'Non-Production',
        BackupSchedule: 'Standard',
        TestingPurpose: 'QA-Integration',
    },
};

export default stagingConfig;
