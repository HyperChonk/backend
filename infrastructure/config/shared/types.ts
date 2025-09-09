/**
 * Environment configuration types for Balancer v3 Backend Infrastructure
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';

export type EnvironmentName = 'development' | 'staging' | 'production';

export interface ResourceConfig {
    /** CPU allocation in CPU units (e.g., 256 for 0.25 vCPU, 1024 for 1 vCPU) */
    cpu: number;
    /** Memory allocation in MiB */
    memoryMiB: number;
}

export interface DatabaseConfig {
    /** RDS instance type */
    instanceSize: ec2.InstanceType;
    /** Database engine version */
    engineVersion: rds.PostgresEngineVersion;
    /** Allocated storage in GB */
    allocatedStorage: number;
    /** Max allocated storage in GB for auto-scaling */
    maxAllocatedStorage?: number;
    /** Backup retention period in days */
    backupRetention: number;
    /** Enable performance insights */
    performanceInsights: boolean;
    /** Enable deletion protection */
    deletionProtection: boolean;
    /** Enable multi-AZ deployment */
    multiAz: boolean;
    /** Connection limits */
    connectionLimits: {
        maxConnections: number;
        maxPoolSize: number;
    };
}

export interface AutoScalingConfig {
    /** Minimum number of instances */
    minInstances: number;
    /** Maximum number of instances */
    maxInstances: number;
    /** Target CPU utilization percentage for auto-scaling */
    targetCpuUtilization: number;
    /** Target memory utilization percentage */
    targetMemoryUtilization: number;
    /** Scale-out cooldown in seconds */
    scaleOutCooldown: number;
    /** Scale-in cooldown in seconds */
    scaleInCooldown: number;
    /** Target queue depth for SQS-based scaling */
    targetQueueLength: number;
    /** Deployment resilience configuration */
    deploymentResilience?: {
        /** Minimum healthy instances during update */
        minHealthyDuringUpdate: number;
        /** Maximum unavailable instances during update */
        maxUnavailableDuringUpdate: number;
        /** Health check grace period in seconds */
        healthCheckGracePeriod: number;
        /** Whether to rollback on failure */
        rollbackOnFailure: boolean;
        /** Test traffic percentage for validation */
        testTrafficPercentage?: number;
    };
}

export interface SqsConfig {
    /** Visibility timeout in seconds */
    visibilityTimeoutSeconds: number;
    /** Message retention period in seconds */
    messageRetentionPeriod: number;
    /** Receive wait time seconds for long polling */
    receiveWaitTimeSeconds: number;
    /** Maximum receive count before moving to DLQ */
    maxReceiveCount: number;
    /** Dead letter queue retention period in seconds */
    dlqRetentionPeriod: number;
}

export interface LoadBalancerConfig {
    /** Enable access logs */
    enableAccessLogs: boolean;
    /** Idle timeout in seconds */
    idleTimeout: number;
    /** Health check interval in seconds */
    healthCheckInterval: number;
    /** Health check timeout in seconds */
    healthCheckTimeout: number;
    /** Healthy threshold count */
    healthyThresholdCount: number;
    /** Unhealthy threshold count */
    unhealthyThresholdCount: number;
    /** Health check path */
    healthCheckPath: string;
    /** SSL/TLS configuration */
    ssl?:
        | {
              /** Enable HTTPS listener */
              enabled: false;
              /** SSL policy for the HTTPS listener */
              sslPolicy?: string;
              /** Redirect HTTP to HTTPS */
              redirectHttpToHttps?: boolean;
          }
        | {
              /** Enable HTTPS listener */
              enabled: true;
              /** Domain name for certificate */
              domainName: string;
              /** Root domain for Route53 hosted zone (e.g., 'hyperchonk.com' for 'dev-api.hyperchonk.com') */
              rootDomain: string;
              /** SSL policy for the HTTPS listener */
              sslPolicy?: string;
              /** Redirect HTTP to HTTPS */
              redirectHttpToHttps?: boolean;
          };
}

export interface MonitoringConfig {
    /** Log retention period using CDK RetentionDays enum */
    logRetention: logs.RetentionDays;
    /** Enable detailed monitoring */
    detailedMonitoring: boolean;
    /** CloudWatch insights retention period */
    insightsRetention: number;
    /** Enable X-Ray tracing */
    enableXRayTracing: boolean;
    /** SNS topic for alerts */
    alertingEnabled: boolean;
    /** Optional remediation topic name override */
    remediationTopicName?: string;
    /** CloudWatch alarm thresholds */
    thresholds: {
        /** SQS queue depth threshold */
        sqsQueueDepth: number;
        /** SQS message age threshold in seconds */
        sqsMessageAge: number;
        /** CPU utilization threshold percentage */
        cpuUtilization: number;
        /** Memory utilization threshold percentage */
        memoryUtilization: number;
    };
}

export interface SecurityConfig {
    /** Enable WAF */
    enableWaf: boolean;
    /** WAF rate limit per 5 minutes */
    wafRateLimit: number;
    /** GraphQL query size limit in bytes */
    graphqlQuerySizeLimit: number;
    /** Enable VPC flow logs */
    enableFlowLogs: boolean;
    /** Enable GuardDuty integration */
    enableGuardDuty: boolean;
    /** Enable Config rules */
    enableConfigRules: boolean;
}

export interface CostConfig {
    /** Enable cost allocation tags */
    enableCostAllocationTags: boolean;
    /** Monthly budget limit in USD */
    monthlyBudgetLimit: number;
    /** Budget alert threshold percentage */
    budgetAlertThreshold: number;
    /** Enable detailed billing */
    enableDetailedBilling: boolean;
}

export interface EnvironmentConfig {
    /** Environment name */
    environment: EnvironmentName;
    /** AWS region */
    region: string;
    /** Resource configuration */
    resources: ResourceConfig;
    /** Database configuration */
    database: DatabaseConfig;
    /** Auto-scaling configuration */
    autoScaling: AutoScalingConfig;
    /** SQS configuration */
    sqs: SqsConfig;
    /** Load balancer configuration */
    loadBalancer: LoadBalancerConfig;
    /** Monitoring configuration */
    monitoring: MonitoringConfig;
    /** Security configuration */
    security: SecurityConfig;
    /** Cost monitoring configuration */
    cost: CostConfig;
    /** Custom tags to apply to resources */
    tags: Record<string, string>;
}

export interface ValidationConstraints {
    /** Minimum CPU allocation in CPU units */
    minCpu: number;
    /** Maximum CPU allocation in CPU units */
    maxCpu: number;
    /** Minimum memory allocation in MiB */
    minMemoryMiB: number;
    /** Maximum memory allocation in MiB */
    maxMemoryMiB: number;
    /** Valid RDS instance types */
    validInstanceTypes: string[];
    /** Valid AWS regions */
    validRegions: string[];
}

export interface DeploymentConfig {
    /** Domain configuration */
    domain?: {
        hostedZoneId: string;
        domainName: string;
        certificateArn: string;
    };
    /** Container configuration */
    container: {
        imageTag: string;
        port: number;
        healthCheckPath: string;
        gracefulShutdownTimeout: number;
    };
    /** Secrets configuration */
    secrets: {
        secretsManagerPrefix: string;
        encryptionKeyAlias: string;
    };
}
