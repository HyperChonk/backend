import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { EnvironmentConfig } from '../shared/types';

/**
 * Development environment configuration
 * Optimized for local development with minimal resource usage and debug features
 */
const developmentConfig: Partial<EnvironmentConfig> = {
    environment: 'development',
    region: 'us-east-1',

    // Reduced resource allocation for development cost optimization
    resources: {
        cpu: 512, // 0.5 vCPU in CPU units (0.5 * 1024) - reduced from 2048
        memoryMiB: 1024, // 1GB - reduced from 4096
    },

    // Development database configuration - cost optimized
    database: {
        instanceSize: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
        engineVersion: rds.PostgresEngineVersion.VER_15,
        allocatedStorage: 20,
        maxAllocatedStorage: 30, // Reduced from 50
        backupRetention: 1, // Minimal backup retention for dev
        performanceInsights: false,
        deletionProtection: false, // Allow easy cleanup in dev
        multiAz: false, // Single AZ for cost savings
        connectionLimits: {
            maxConnections: 25, // Reduced from 50 to match lower resource usage
            maxPoolSize: 3, // Reduced from 5
        },
    },

    // Resilient but cost-effective auto-scaling for development
    autoScaling: {
        minInstances: 1, // Minimum 1 for availability
        maxInstances: 3, // Allow scaling for testing
        targetCpuUtilization: 70, // Lower threshold for better responsiveness
        targetMemoryUtilization: 80,
        scaleOutCooldown: 300, // Faster scale-out for dev testing
        scaleInCooldown: 600, // Moderate scale-in
        targetQueueLength: 10,
        // Enhanced deployment resilience
        deploymentResilience: {
            minHealthyDuringUpdate: 1, // Always keep 1 instance healthy
            maxUnavailableDuringUpdate: 0, // Zero downtime during updates
            healthCheckGracePeriod: 300, // 5 min grace period
            rollbackOnFailure: true,
        },
    },

    // Development SQS configuration
    sqs: {
        visibilityTimeoutSeconds: 30,
        messageRetentionPeriod: 345600, // 4 days (shorter than other envs)
        receiveWaitTimeSeconds: 10,
        maxReceiveCount: 2,
        dlqRetentionPeriod: 345600, // 4 days
    },

    // Development load balancer configuration
    loadBalancer: {
        enableAccessLogs: true, // Enable to test ALB access logs pre-prod
        idleTimeout: 60,
        healthCheckInterval: 30, // More frequent checks for faster feedback
        healthCheckTimeout: 15, // Longer timeout for slower dev containers
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5, // More lenient failure tolerance
        healthCheckPath: '/health',
        ssl: {
            enabled: true, // Enable SSL for development
            redirectHttpToHttps: false, // Keep both HTTP and HTTPS available for development
            sslPolicy: 'ELBSecurityPolicy-TLS-1-2-2017-01',
            domainName: 'dev-api.hyperchonk.com', // Your actual GoDaddy subdomain
            rootDomain: 'hyperchonk.com', // Root domain for Route53 hosted zone
        },
    },

    // Development monitoring configuration
    monitoring: {
        logRetention: logs.RetentionDays.THREE_DAYS, // Shorter log retention for dev
        detailedMonitoring: false,
        insightsRetention: 1,
        enableXRayTracing: false, // Disable for cost savings
        alertingEnabled: false, // No alerts in dev
        thresholds: {
            sqsQueueDepth: 20, // Lower threshold for dev
            sqsMessageAge: 600, // 10 minutes - more relaxed
            cpuUtilization: 85, // Higher threshold for dev
            memoryUtilization: 90, // Higher threshold for dev
        },
    },

    // Minimal security for development
    security: {
        enableWaf: false, // Disable WAF for dev
        wafRateLimit: 1000,
        graphqlQuerySizeLimit: 8000, // 8KB - smaller for development testing
        enableFlowLogs: false, // Enable for log forwarding testing
        enableGuardDuty: false,
        enableConfigRules: false,
    },

    // Development cost configuration
    cost: {
        enableCostAllocationTags: true,
        monthlyBudgetLimit: 50, // Low budget for development
        budgetAlertThreshold: 75,
        enableDetailedBilling: false, // Simplified billing for dev
    },

    // Development-specific tags
    tags: {
        Environment: 'development',
        Owner: 'Development Team',
        CostCenter: 'Development',
        AutoShutdown: 'true', // Can be auto-shutdown during off-hours
        DataClassification: 'Non-Production',
        BackupSchedule: 'Minimal',
    },
};

export default developmentConfig;
