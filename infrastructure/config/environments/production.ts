import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { EnvironmentConfig } from '../shared/types';

/**
 * Production environment configuration
 * Optimized for production workloads with full resource allocation, high availability, and enterprise-grade security
 */
const productionConfig: Partial<EnvironmentConfig> = {
    environment: 'production',
    region: 'us-east-1',

    // Full resource allocation for production
    resources: {
        cpu: 1024, // 1 vCPU in CPU units (1 * 1024)
        memoryMiB: 2048,
    },

    // Production database configuration
    database: {
        instanceSize: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
        engineVersion: rds.PostgresEngineVersion.VER_15,
        allocatedStorage: 50,
        maxAllocatedStorage: 200,
        backupRetention: 30, // Extended backup retention for production
        performanceInsights: true,
        deletionProtection: true, // Prevent accidental deletion
        multiAz: true, // High availability across multiple AZs
        connectionLimits: {
            maxConnections: 200,
            maxPoolSize: 20,
        },
    },

    // Robust auto-scaling for production
    autoScaling: {
        minInstances: 1,
        maxInstances: 3,
        targetCpuUtilization: 60, // Conservative CPU target
        targetMemoryUtilization: 70, // Conservative memory target
        scaleOutCooldown: 180, // Faster scale-out for production
        scaleInCooldown: 600, // Slower scale-in to prevent thrashing
        targetQueueLength: 10, // Queue depth per instance for production
    },

    // Production SQS configuration
    sqs: {
        visibilityTimeoutSeconds: 60,
        messageRetentionPeriod: 345600, // 4 days
        receiveWaitTimeSeconds: 20,
        maxReceiveCount: 5, // More retries for production
        dlqRetentionPeriod: 345600, // 4 days
    },

    // Production load balancer configuration
    loadBalancer: {
        enableAccessLogs: true, // Enable for compliance and monitoring
        idleTimeout: 60,
        healthCheckInterval: 30,
        healthCheckTimeout: 5,
        healthyThresholdCount: 3, // More conservative health checks
        unhealthyThresholdCount: 2, // Faster unhealthy detection
        healthCheckPath: '/health',
        ssl: {
            enabled: true, // SSL required for production
            redirectHttpToHttps: true, // Force HTTPS for security
            sslPolicy: 'ELBSecurityPolicy-TLS-1-2-2017-01', // Secure TLS 1.2+ policy
            domainName: 'api.hyperchonk.com', // Production domain
            rootDomain: 'hyperchonk.com', // Root domain for Route53 hosted zone
        },
    },

    // Comprehensive monitoring for production
    monitoring: {
        logRetention: logs.RetentionDays.ONE_MONTH, // Extended log retention for compliance
        detailedMonitoring: true,
        insightsRetention: 30, // Extended insights retention
        enableXRayTracing: true,
        alertingEnabled: true, // Critical for production
        thresholds: {
            sqsQueueDepth: 100, // Higher threshold for production volume
            sqsMessageAge: 180, // 3 minutes - stricter for production
            cpuUtilization: 60, // Conservative threshold for production
            memoryUtilization: 70, // Conservative threshold for production
        },
    },

    // Full security suite for production
    security: {
        enableWaf: true,
        wafRateLimit: 2000, // Higher rate limit for production traffic
        graphqlQuerySizeLimit: 20000, // 20KB - larger limit for production complex queries
        enableFlowLogs: true, // Enable for security analysis
        enableGuardDuty: true, // Enable threat detection
        enableConfigRules: true, // Enable compliance monitoring
    },

    // Production cost configuration
    cost: {
        enableCostAllocationTags: true,
        monthlyBudgetLimit: 500, // Higher budget for production
        budgetAlertThreshold: 85, // Conservative budget alerting
        enableDetailedBilling: true,
    },

    // Production-specific tags
    tags: {
        Environment: 'production',
        Owner: 'Platform Team',
        CostCenter: 'Production',
        AutoShutdown: 'false', // Never auto-shutdown production
        DataClassification: 'Production',
        BackupSchedule: 'Daily',
        Compliance: 'Required',
        MonitoringLevel: 'Critical',
        SLA: 'Tier1',
    },
};

export default productionConfig;
