import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/shared/types';
import { generateResourceName } from '../../config/environments/shared';

export interface MonitoringStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
    clusterName: string;
    database?: rds.DatabaseInstance;
    backgroundJobQueue: sqs.Queue;
    dataRefreshQueue: sqs.Queue;
    notificationQueue: sqs.Queue;
    serviceNamePrefix: string;
    wafWebAclName?: string;
    alertEmail?: string;
}

/**
 * Monitoring Stack for Balancer v3 Backend
 *
 * Creates comprehensive CloudWatch monitoring including:
 * - Custom dashboards for application metrics
 * - Alarms for critical infrastructure components
 * - GraphQL-specific monitoring
 * - Database performance monitoring
 * - SQS queue depth and processing monitoring
 * - WAF security monitoring
 * - SNS notifications for alerts
 */
export class MonitoringStack extends cdk.Stack {
    public readonly dashboard: cloudwatch.Dashboard;
    public readonly alertTopic: sns.Topic;
    public readonly alarms: cloudwatch.Alarm[];
    private remediationLambda?: lambda.Function;
    private remediationTopic?: sns.Topic;

    constructor(scope: Construct, id: string, props: MonitoringStackProps) {
        super(scope, id, props);

        const {
            config,
            clusterName,
            database,
            backgroundJobQueue,
            dataRefreshQueue,
            notificationQueue,
            serviceNamePrefix,
            wafWebAclName,
            alertEmail,
        } = props;

        // Lookup infrastructure resources instead of using direct references
        const infrastructure = this.lookupInfrastructure(config, clusterName);

        this.alarms = [];

        // Create SNS topic for alerts
        this.alertTopic = this.createAlertTopic(config, alertEmail);

        // Create CloudWatch Dashboard
        this.dashboard = this.createDashboard(config);

        // Create remediation lambda for auto-recovery actions
        this.remediationLambda = this.createRemediationLambda(config, serviceNamePrefix, clusterName);

        // Create remediation SNS topic and subscribe the remediation lambda
        this.remediationTopic = new sns.Topic(this, 'RemediationTopic', {
            topicName:
                config.monitoring.remediationTopicName || generateResourceName('remediation', config.environment),
            displayName: `Balancer v3 Backend ${config.environment} Remediation`,
        });
        if (this.remediationLambda) {
            this.remediationTopic.addSubscription(new snsSubscriptions.LambdaSubscription(this.remediationLambda));
        }

        // Create ECS monitoring
        this.createEcsMonitoring(config, infrastructure.cluster as ecs.Cluster, serviceNamePrefix, clusterName);

        // Create ALB monitoring
        if (infrastructure.loadBalancer) {
            // Cast to concrete type for monitoring
            this.createAlbMonitoring(config, infrastructure.loadBalancer as elbv2.ApplicationLoadBalancer);
        }

        // Create database monitoring
        if (database) {
            this.createDatabaseMonitoring(config, database);
        }

        // Create SQS monitoring
        this.createSqsMonitoring(config, backgroundJobQueue, dataRefreshQueue, notificationQueue);

        // Removed OOM log-driven auto-recovery; upstream service was the source of OOM

        // Create WAF monitoring
        if (wafWebAclName) {
            this.createWafMonitoring(config, wafWebAclName);
        }

        // Create application-specific monitoring
        this.createApplicationMonitoring(config);

        // Apply tags
        this.applyTags(config);

        // Create outputs
        this.createOutputs(config);
    }

    /**
     * Create SNS topic for alert notifications
     */
    private createAlertTopic(config: EnvironmentConfig, alertEmail?: string): sns.Topic {
        const topic = new sns.Topic(this, 'AlertTopic', {
            topicName: generateResourceName('alerts', config.environment),
            displayName: `Balancer v3 Backend ${config.environment} Alerts`,
        });

        // Subscribe email if provided
        if (alertEmail) {
            topic.addSubscription(new snsSubscriptions.EmailSubscription(alertEmail));
        }

        return topic;
    }

    /**
     * Create CloudWatch Dashboard
     */
    private createDashboard(config: EnvironmentConfig): cloudwatch.Dashboard {
        return new cloudwatch.Dashboard(this, 'Dashboard', {
            dashboardName: generateResourceName('dashboard', config.environment),
            widgets: [], // Widgets will be added by individual monitoring methods
        });
    }

    /**
     * Create ECS service monitoring using service lookups
     */
    private createEcsMonitoring(
        config: EnvironmentConfig,
        cluster: ecs.Cluster,
        serviceNamePrefix: string,
        clusterName: string,
    ): void {
        // Lookup services by name with error handling
        const services = this.lookupServices(cluster, serviceNamePrefix, clusterName);

        // Create monitoring for each service that was successfully found
        if (services.apiService) {
            this.createServiceMonitoring(config, services.apiService, 'api', 80, 85);
        }

        if (services.workerService) {
            this.createServiceMonitoring(config, services.workerService, 'worker', 80, 85);
        }

        if (services.schedulerService) {
            this.createServiceMonitoring(config, services.schedulerService, 'scheduler', 80, 85);
        }

        // Create dashboard widgets with available services
        this.createEcsDashboardWidgets(services);
    }

    private createRemediationLambda(config: EnvironmentConfig, serviceNamePrefix: string, clusterName: string) {
        const role = new iam.Role(this, 'WorkerRemediationLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
        });

        // Allow updating the ECS service
        role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['ecs:UpdateService', 'ecs:DescribeServices', 'ecs:DescribeClusters'],
                resources: ['*'],
            }),
        );

        const fn = new lambda.Function(this, 'WorkerRemediationLambda', {
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            timeout: cdk.Duration.seconds(30),
            code: lambda.Code.fromInline(
                "'use strict';\n" +
                    "const { ECSClient, UpdateServiceCommand } = require('@aws-sdk/client-ecs');\n" +
                    'const ecs = new ECSClient({});\n' +
                    'exports.handler = async (event) => {\n' +
                    '  const cluster = process.env.CLUSTER_NAME;\n' +
                    '  const service = process.env.SERVICE_NAME;\n' +
                    "  console.log('Remediation trigger event:', JSON.stringify(event));\n" +
                    '  try {\n' +
                    '    // Force a new deployment to recycle the task\n' +
                    '    await ecs.send(new UpdateServiceCommand({ cluster, service, forceNewDeployment: true }));\n' +
                    "    console.log('ForceNewDeployment initiated for', service, 'on', cluster);\n" +
                    "    return { statusCode: 200, body: 'Deployment forced' };\n" +
                    '  } catch (err) {\n' +
                    "    console.error('Failed to force deployment', err);\n" +
                    '    throw err;\n' +
                    '  }\n' +
                    '};\n',
            ),
            environment: {
                CLUSTER_NAME: clusterName,
                SERVICE_NAME: `${serviceNamePrefix}-worker-service`,
            },
            role,
        });

        return fn;
    }

    /**
     * Lookup ECS services with graceful error handling
     */
    private lookupInfrastructure(config: EnvironmentConfig, clusterName: string) {
        // Lookup ECS cluster by ARN
        const clusterArn = `arn:aws:ecs:${this.region}:${this.account}:cluster/${clusterName}`;
        const cluster = ecs.Cluster.fromClusterArn(this, 'ClusterLookup', clusterArn);

        // Lookup load balancer ARN from SSM parameter
        let loadBalancer: elbv2.IApplicationLoadBalancer | undefined;
        try {
            const albArnParameter = ssm.StringParameter.fromStringParameterName(
                this,
                'AlbArnParameter',
                `/v3-backend/${config.environment}/compute/albArn`,
            );
            const loadBalancerArn = albArnParameter.stringValue;

            if (loadBalancerArn) {
                loadBalancer = elbv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(
                    this,
                    'LoadBalancerLookup',
                    {
                        loadBalancerArn,
                        securityGroupId: '', // We don't need security group for monitoring
                    },
                );
            }
        } catch (error) {
            console.warn(`⚠️ Could not lookup ALB ARN from SSM parameter:`, error);
        }

        return { cluster, loadBalancer };
    }

    private lookupServices(cluster: ecs.Cluster, serviceNamePrefix: string, clusterName: string) {
        const services: {
            apiService?: ecs.IBaseService;
            workerService?: ecs.IBaseService;
            schedulerService?: ecs.IBaseService;
        } = {};

        // Check if this is an infra-only deployment
        const infraOnly =
            this.node.tryGetContext('infraOnly') ||
            this.node.tryGetContext('infra-only') ||
            process.env.INFRA_ONLY === 'true';

        if (infraOnly) {
            console.log(`ℹ️  Skipping ECS service lookups in infra-only mode`);
            return services;
        }

        // API Service lookup
        try {
            services.apiService = ecs.FargateService.fromFargateServiceAttributes(this, 'ApiServiceLookup', {
                cluster,
                serviceName: `${serviceNamePrefix}-api-service`,
            });
            console.log(`✅ Successfully looked up API service: ${serviceNamePrefix}-api-service`);
        } catch (error) {
            console.warn(`⚠️ Could not lookup API service ${serviceNamePrefix}-api-service:`, error);
        }

        // Worker Service lookup
        try {
            services.workerService = ecs.FargateService.fromFargateServiceAttributes(this, 'WorkerServiceLookup', {
                cluster,
                serviceName: `${serviceNamePrefix}-worker-service`,
            });
            console.log(`✅ Successfully looked up Worker service: ${serviceNamePrefix}-worker-service`);
        } catch (error) {
            console.warn(`⚠️ Could not lookup Worker service ${serviceNamePrefix}-worker-service:`, error);
        }

        // Scheduler Service lookup
        try {
            services.schedulerService = ecs.FargateService.fromFargateServiceAttributes(
                this,
                'SchedulerServiceLookup',
                {
                    cluster,
                    serviceName: `${serviceNamePrefix}-scheduler-service`,
                },
            );
            console.log(`✅ Successfully looked up Scheduler service: ${serviceNamePrefix}-scheduler-service`);
        } catch (error) {
            console.warn(`⚠️ Could not lookup Scheduler service ${serviceNamePrefix}-scheduler-service:`, error);
        }

        return services;
    }

    /**
     * Create monitoring for a specific service
     */
    private createServiceMonitoring(
        config: EnvironmentConfig,
        service: ecs.IBaseService,
        serviceName: string,
        cpuThreshold: number,
        memoryThreshold: number,
    ): void {
        // Create CPU metric manually
        const cpuMetric = new cloudwatch.Metric({
            namespace: 'AWS/ECS',
            metricName: 'CPUUtilization',
            dimensionsMap: {
                ServiceName: service.serviceName,
                ClusterName: service.cluster.clusterName,
            },
            period: cdk.Duration.minutes(5),
            statistic: 'Average',
        });

        // CPU monitoring
        const cpuAlarm = new cloudwatch.Alarm(this, `${serviceName}ServiceHighCpu`, {
            alarmName: generateResourceName(`${serviceName}-high-cpu`, config.environment),
            alarmDescription: `${serviceName} service CPU utilization is high`,
            metric: cpuMetric,
            threshold: cpuThreshold,
            evaluationPeriods: serviceName === 'api' ? 2 : 3,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        cpuAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        this.alarms.push(cpuAlarm);

        // Create Memory metric manually
        const memoryMetric = new cloudwatch.Metric({
            namespace: 'AWS/ECS',
            metricName: 'MemoryUtilization',
            dimensionsMap: {
                ServiceName: service.serviceName,
                ClusterName: service.cluster.clusterName,
            },
            period: cdk.Duration.minutes(5),
            statistic: 'Average',
        });

        // Memory monitoring
        const memoryAlarm = new cloudwatch.Alarm(this, `${serviceName}ServiceHighMemory`, {
            alarmName: generateResourceName(`${serviceName}-high-memory`, config.environment),
            alarmDescription: `${serviceName} service memory utilization is high`,
            metric: memoryMetric,
            threshold: memoryThreshold,
            evaluationPeriods: serviceName === 'api' ? 2 : 3,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        memoryAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        this.alarms.push(memoryAlarm);
    }

    /**
     * Create ECS dashboard widgets with available services
     */
    private createEcsDashboardWidgets(services: {
        apiService?: ecs.IBaseService;
        workerService?: ecs.IBaseService;
        schedulerService?: ecs.IBaseService;
    }): void {
        const cpuMetrics: cloudwatch.IMetric[] = [];
        const memoryMetrics: cloudwatch.IMetric[] = [];

        if (services.apiService) {
            cpuMetrics.push(
                new cloudwatch.Metric({
                    namespace: 'AWS/ECS',
                    metricName: 'CPUUtilization',
                    dimensionsMap: {
                        ServiceName: services.apiService.serviceName,
                        ClusterName: services.apiService.cluster.clusterName,
                    },
                    label: 'API Service',
                }),
            );
            memoryMetrics.push(
                new cloudwatch.Metric({
                    namespace: 'AWS/ECS',
                    metricName: 'MemoryUtilization',
                    dimensionsMap: {
                        ServiceName: services.apiService.serviceName,
                        ClusterName: services.apiService.cluster.clusterName,
                    },
                    label: 'API Service',
                }),
            );
        }

        if (services.workerService) {
            cpuMetrics.push(
                new cloudwatch.Metric({
                    namespace: 'AWS/ECS',
                    metricName: 'CPUUtilization',
                    dimensionsMap: {
                        ServiceName: services.workerService.serviceName,
                        ClusterName: services.workerService.cluster.clusterName,
                    },
                    label: 'Worker Service',
                }),
            );
            memoryMetrics.push(
                new cloudwatch.Metric({
                    namespace: 'AWS/ECS',
                    metricName: 'MemoryUtilization',
                    dimensionsMap: {
                        ServiceName: services.workerService.serviceName,
                        ClusterName: services.workerService.cluster.clusterName,
                    },
                    label: 'Worker Service',
                }),
            );
        }

        if (services.schedulerService) {
            cpuMetrics.push(
                new cloudwatch.Metric({
                    namespace: 'AWS/ECS',
                    metricName: 'CPUUtilization',
                    dimensionsMap: {
                        ServiceName: services.schedulerService.serviceName,
                        ClusterName: services.schedulerService.cluster.clusterName,
                    },
                    label: 'Scheduler Service',
                }),
            );
            memoryMetrics.push(
                new cloudwatch.Metric({
                    namespace: 'AWS/ECS',
                    metricName: 'MemoryUtilization',
                    dimensionsMap: {
                        ServiceName: services.schedulerService.serviceName,
                        ClusterName: services.schedulerService.cluster.clusterName,
                    },
                    label: 'Scheduler Service',
                }),
            );
        }

        // Only create widgets if we have metrics
        if (cpuMetrics.length > 0) {
            this.dashboard.addWidgets(
                new cloudwatch.GraphWidget({
                    title: 'ECS Service CPU Utilization',
                    left: cpuMetrics,
                    width: 12,
                    height: 6,
                }),
                new cloudwatch.GraphWidget({
                    title: 'ECS Service Memory Utilization',
                    left: memoryMetrics,
                    width: 12,
                    height: 6,
                }),
            );
        } else {
            console.warn('⚠️ No ECS services found for dashboard widgets');
        }
    }

    /**
     * Create Application Load Balancer monitoring
     */
    private createAlbMonitoring(config: EnvironmentConfig, loadBalancer: elbv2.ApplicationLoadBalancer): void {
        // ALB Target Response Time
        const responseTimeAlarm = new cloudwatch.Alarm(this, 'AlbHighResponseTime', {
            alarmName: generateResourceName('alb-high-response-time', config.environment),
            alarmDescription: 'ALB target response time is high',
            metric: loadBalancer.metrics.targetResponseTime({
                period: cdk.Duration.minutes(5),
                statistic: 'Average',
            }),
            threshold: 2, // 2 seconds
            evaluationPeriods: 2,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        responseTimeAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        this.alarms.push(responseTimeAlarm);

        // ALB HTTP 5xx errors
        const http5xxAlarm = new cloudwatch.Alarm(this, 'AlbHigh5xxErrors', {
            alarmName: generateResourceName('alb-high-5xx-errors', config.environment),
            alarmDescription: 'ALB 5xx error rate is high',
            metric: loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
                period: cdk.Duration.minutes(5),
                statistic: 'Sum',
            }),
            threshold: 10,
            evaluationPeriods: 2,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        http5xxAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        this.alarms.push(http5xxAlarm);

        // ALB Dashboard widgets
        this.dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'ALB Request Count & Response Time',
                left: [loadBalancer.metrics.requestCount({ label: 'Request Count' })],
                right: [loadBalancer.metrics.targetResponseTime({ label: 'Response Time' })],
                width: 12,
                height: 6,
            }),
            new cloudwatch.GraphWidget({
                title: 'ALB HTTP Status Codes',
                left: [
                    loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_2XX_COUNT, { label: '2xx' }),
                    loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_4XX_COUNT, { label: '4xx' }),
                    loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { label: '5xx' }),
                ],
                width: 12,
                height: 6,
            }),
        );
    }

    /**
     * Create database monitoring
     */
    private createDatabaseMonitoring(config: EnvironmentConfig, database: rds.DatabaseInstance): void {
        // Database CPU monitoring
        const dbCpuAlarm = new cloudwatch.Alarm(this, 'DatabaseHighCpu', {
            alarmName: generateResourceName('db-high-cpu', config.environment),
            alarmDescription: 'Database CPU utilization is high',
            metric: database.metricCPUUtilization({
                period: cdk.Duration.minutes(5),
                statistic: 'Average',
            }),
            threshold: 80,
            evaluationPeriods: 2,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        dbCpuAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        this.alarms.push(dbCpuAlarm);

        // Database connection monitoring
        const dbConnectionAlarm = new cloudwatch.Alarm(this, 'DatabaseHighConnections', {
            alarmName: generateResourceName('db-high-connections', config.environment),
            alarmDescription: 'Database connection count is high',
            metric: database.metricDatabaseConnections({
                period: cdk.Duration.minutes(5),
                statistic: 'Average',
            }),
            threshold: config.database.connectionLimits.maxConnections * 0.8, // 80% of max connections
            evaluationPeriods: 2,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        dbConnectionAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        this.alarms.push(dbConnectionAlarm);

        // Database Dashboard widgets
        this.dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'Database Performance',
                left: [
                    database.metricCPUUtilization({ label: 'CPU Utilization' }),
                    database.metricDatabaseConnections({ label: 'Connections' }),
                ],
                right: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/RDS',
                        metricName: 'ReadLatency',
                        dimensionsMap: {
                            DBInstanceIdentifier: database.instanceIdentifier,
                        },
                        label: 'Read Latency',
                    }),
                ],
                width: 12,
                height: 6,
            }),
        );
    }

    /**
     * Create SQS queue monitoring
     */
    private createSqsMonitoring(
        config: EnvironmentConfig,
        backgroundJobQueue: sqs.Queue,
        dataRefreshQueue: sqs.Queue,
        notificationQueue: sqs.Queue,
    ): void {
        // Background job queue depth monitoring
        const bgQueueDepthAlarm = new cloudwatch.Alarm(this, 'BackgroundJobQueueHighDepth', {
            alarmName: generateResourceName('bg-queue-high-depth', config.environment),
            alarmDescription: 'Background job queue depth is high',
            metric: backgroundJobQueue.metricApproximateNumberOfMessagesVisible({
                period: cdk.Duration.minutes(5),
                statistic: 'Average',
            }),
            threshold: config.monitoring.thresholds.sqsQueueDepth,
            evaluationPeriods: 2,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        bgQueueDepthAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        if (this.remediationTopic) {
            bgQueueDepthAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.remediationTopic));
        }
        this.alarms.push(bgQueueDepthAlarm);

        // Data refresh queue depth monitoring
        const dataQueueDepthAlarm = new cloudwatch.Alarm(this, 'DataRefreshQueueHighDepth', {
            alarmName: generateResourceName('data-queue-high-depth', config.environment),
            alarmDescription: 'Data refresh queue depth is high',
            metric: dataRefreshQueue.metricApproximateNumberOfMessagesVisible({
                period: cdk.Duration.minutes(5),
                statistic: 'Average',
            }),
            threshold: config.monitoring.thresholds.sqsQueueDepth,
            evaluationPeriods: 2,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        dataQueueDepthAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        if (this.remediationTopic) {
            dataQueueDepthAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.remediationTopic));
        }
        this.alarms.push(dataQueueDepthAlarm);

        // Age of oldest message monitoring (remediation)
        const bgQueueAgeAlarm = new cloudwatch.Alarm(this, 'BackgroundJobQueueHighAge', {
            alarmName: generateResourceName('bg-queue-high-age', config.environment),
            alarmDescription: 'Background job queue message age is high',
            metric: backgroundJobQueue.metricApproximateAgeOfOldestMessage({
                period: cdk.Duration.minutes(5),
                statistic: 'Maximum',
            }),
            threshold: config.monitoring.thresholds.sqsMessageAge,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        bgQueueAgeAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        if (this.remediationTopic) {
            bgQueueAgeAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.remediationTopic));
        }
        this.alarms.push(bgQueueAgeAlarm);

        const dataQueueAgeAlarm = new cloudwatch.Alarm(this, 'DataRefreshQueueHighAge', {
            alarmName: generateResourceName('data-queue-high-age', config.environment),
            alarmDescription: 'Data refresh queue message age is high',
            metric: dataRefreshQueue.metricApproximateAgeOfOldestMessage({
                period: cdk.Duration.minutes(5),
                statistic: 'Maximum',
            }),
            threshold: config.monitoring.thresholds.sqsMessageAge,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        dataQueueAgeAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        if (this.remediationTopic) {
            dataQueueAgeAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.remediationTopic));
        }
        this.alarms.push(dataQueueAgeAlarm);

        // SQS Dashboard widgets
        this.dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'SQS Queue Depths',
                left: [
                    backgroundJobQueue.metricApproximateNumberOfMessagesVisible({ label: 'Background Jobs' }),
                    dataRefreshQueue.metricApproximateNumberOfMessagesVisible({ label: 'Data Refresh' }),
                    notificationQueue.metricApproximateNumberOfMessagesVisible({ label: 'Notifications' }),
                ],
                width: 12,
                height: 6,
            }),
        );
    }

    // OOM log-driven auto-recovery intentionally removed

    /**
     * Create WAF monitoring
     */
    private createWafMonitoring(config: EnvironmentConfig, wafWebAclName: string): void {
        // WAF blocked requests monitoring
        const wafBlockedRequestsMetric = new cloudwatch.Metric({
            namespace: 'AWS/WAFV2',
            metricName: 'BlockedRequests',
            dimensionsMap: {
                WebACL: wafWebAclName,
                Region: this.region,
            },
            period: cdk.Duration.minutes(5),
            statistic: 'Sum',
        });

        const wafBlockedRequestsAlarm = new cloudwatch.Alarm(this, 'WafHighBlockedRequests', {
            alarmName: generateResourceName('waf-high-blocked-requests', config.environment),
            alarmDescription: 'WAF is blocking a high number of requests',
            metric: wafBlockedRequestsMetric,
            threshold: 100,
            evaluationPeriods: 2,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        wafBlockedRequestsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        this.alarms.push(wafBlockedRequestsAlarm);

        // WAF Dashboard widgets
        const wafAllowedRequestsMetric = new cloudwatch.Metric({
            namespace: 'AWS/WAFV2',
            metricName: 'AllowedRequests',
            dimensionsMap: {
                WebACL: wafWebAclName,
                Region: this.region,
            },
            period: cdk.Duration.minutes(5),
            statistic: 'Sum',
        });

        this.dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'WAF Request Statistics',
                left: [
                    wafAllowedRequestsMetric.with({ label: 'Allowed Requests' }),
                    wafBlockedRequestsMetric.with({ label: 'Blocked Requests' }),
                ],
                width: 12,
                height: 6,
            }),
        );
    }

    /**
     * Create application-specific monitoring
     */
    private createApplicationMonitoring(config: EnvironmentConfig): void {
        // GraphQL operation metrics (custom metrics that the application should publish)
        const graphqlErrorRate = new cloudwatch.Metric({
            namespace: 'BalancerV3/GraphQL',
            metricName: 'ErrorRate',
            dimensionsMap: {
                Environment: config.environment,
            },
            period: cdk.Duration.minutes(5),
            statistic: 'Average',
        });

        const graphqlErrorRateAlarm = new cloudwatch.Alarm(this, 'GraphQLHighErrorRate', {
            alarmName: generateResourceName('graphql-high-error-rate', config.environment),
            alarmDescription: 'GraphQL error rate is high',
            metric: graphqlErrorRate,
            threshold: 5, // 5% error rate
            evaluationPeriods: 2,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        graphqlErrorRateAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        this.alarms.push(graphqlErrorRateAlarm);

        // GraphQL operation latency
        const graphqlLatency = new cloudwatch.Metric({
            namespace: 'BalancerV3/GraphQL',
            metricName: 'OperationLatency',
            dimensionsMap: {
                Environment: config.environment,
            },
            period: cdk.Duration.minutes(5),
            statistic: 'Average',
        });

        const graphqlLatencyAlarm = new cloudwatch.Alarm(this, 'GraphQLHighLatency', {
            alarmName: generateResourceName('graphql-high-latency', config.environment),
            alarmDescription: 'GraphQL operation latency is high',
            metric: graphqlLatency,
            threshold: 2000, // 2 seconds
            evaluationPeriods: 2,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        graphqlLatencyAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
        this.alarms.push(graphqlLatencyAlarm);

        // Application Dashboard widgets
        this.dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'GraphQL Operations',
                left: [
                    new cloudwatch.Metric({
                        namespace: 'BalancerV3/GraphQL',
                        metricName: 'OperationCount',
                        dimensionsMap: { Environment: config.environment },
                        label: 'Operation Count',
                    }),
                    graphqlErrorRate.with({ label: 'Error Rate (%)' }),
                ],
                right: [graphqlLatency.with({ label: 'Latency (ms)' })],
                width: 12,
                height: 6,
            }),
        );
    }

    /**
     * Apply consistent tags to all resources
     */
    private applyTags(config: EnvironmentConfig): void {
        const resources = [this.dashboard, this.alertTopic, ...this.alarms];

        resources.forEach((resource) => {
            Object.entries(config.tags).forEach(([key, value]) => {
                cdk.Tags.of(resource).add(key, value);
            });
            cdk.Tags.of(resource).add('Stack', 'Monitoring');
        });
    }

    /**
     * Create CloudFormation outputs
     */
    private createOutputs(config: EnvironmentConfig): void {
        new cdk.CfnOutput(this, 'DashboardUrl', {
            value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.dashboard.dashboardName}`,
            description: 'CloudWatch Dashboard URL',
            exportName: `${config.environment}-dashboard-url`,
        });

        new cdk.CfnOutput(this, 'AlertTopicArn', {
            value: this.alertTopic.topicArn,
            description: 'SNS Topic ARN for Alerts',
            exportName: `${config.environment}-alert-topic-arn`,
        });

        new cdk.CfnOutput(this, 'AlarmCount', {
            value: this.alarms.length.toString(),
            description: 'Number of CloudWatch Alarms Created',
            exportName: `${config.environment}-alarm-count`,
        });
    }
}
