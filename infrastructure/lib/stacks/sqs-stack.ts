import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/shared/types';
import { generateResourceName } from '../../config/environments/shared';

export interface SqsStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
}

/**
 * SQS Stack for Balancer v3 Backend
 *
 * Creates SQS queues for background job processing with:
 * - Standard queues for background jobs
 * - Dead letter queues for failed job handling
 * - CloudWatch monitoring and alarms
 * - Environment-specific configuration
 */
export class SqsStack extends cdk.Stack {
    public readonly backgroundJobQueue: sqs.Queue;
    public readonly backgroundJobDlq: sqs.Queue;
    public readonly dataRefreshQueue: sqs.Queue;
    public readonly dataRefreshDlq: sqs.Queue;
    public readonly notificationQueue: sqs.Queue;
    public readonly notificationDlq: sqs.Queue;
    public readonly encryptionKey: kms.Key;

    constructor(scope: Construct, id: string, props: SqsStackProps) {
        super(scope, id, props);

        const { config } = props;

        // Create KMS key for SQS encryption
        this.encryptionKey = this.createEncryptionKey(config);

        // Create Dead Letter Queues first
        this.backgroundJobDlq = this.createDeadLetterQueue('background-job-dlq', config);
        this.dataRefreshDlq = this.createDeadLetterQueue('data-refresh-dlq', config);
        this.notificationDlq = this.createDeadLetterQueue('notification-dlq', config);

        // Create main queues with DLQ configuration
        this.backgroundJobQueue = this.createMainQueue('background-job-queue', this.backgroundJobDlq, config);
        this.dataRefreshQueue = this.createMainQueue('data-refresh-queue', this.dataRefreshDlq, config);
        this.notificationQueue = this.createMainQueue('notification-queue', this.notificationDlq, config);

        // Create CloudWatch monitoring
        this.createCloudWatchMonitoring(config);

        // Apply tags
        this.applyTags(config);

    }

    /**
     * Create KMS key for SQS encryption
     */
    private createEncryptionKey(config: EnvironmentConfig): kms.Key {
        const key = new kms.Key(this, 'SQSEncryptionKey', {
            alias: `alias/${generateResourceName('sqs-encryption', config.environment)}`,
            description: `SQS encryption key for Balancer v3 Backend ${config.environment} environment`,
            enableKeyRotation: true,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        // Allow SQS service to use the key
        key.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal('sqs.amazonaws.com')],
                actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:Encrypt'],
                resources: ['*'],
                conditions: {
                    StringEquals: {
                        'kms:via': 'sqs.amazonaws.com',
                    },
                },
            }),
        );

        return key;
    }

    /**
     * Create a dead letter queue
     */
    private createDeadLetterQueue(queueType: string, config: EnvironmentConfig): sqs.Queue {
        return new sqs.Queue(this, `${this.toPascalCase(queueType)}`, {
            queueName: generateResourceName(queueType, config.environment),
            retentionPeriod: cdk.Duration.seconds(config.sqs.dlqRetentionPeriod),
            visibilityTimeout: cdk.Duration.seconds(config.sqs.visibilityTimeoutSeconds),
            receiveMessageWaitTime: cdk.Duration.seconds(config.sqs.receiveWaitTimeSeconds),
            encryption: sqs.QueueEncryption.KMS,
            encryptionMasterKey: this.encryptionKey,
        });
    }

    /**
     * Create a main queue with DLQ configuration
     */
    private createMainQueue(queueType: string, dlq: sqs.Queue, config: EnvironmentConfig): sqs.Queue {
        return new sqs.Queue(this, `${this.toPascalCase(queueType)}`, {
            queueName: generateResourceName(queueType, config.environment),
            retentionPeriod: cdk.Duration.seconds(config.sqs.messageRetentionPeriod),
            visibilityTimeout: cdk.Duration.seconds(config.sqs.visibilityTimeoutSeconds),
            receiveMessageWaitTime: cdk.Duration.seconds(config.sqs.receiveWaitTimeSeconds),
            encryption: sqs.QueueEncryption.KMS,
            encryptionMasterKey: this.encryptionKey,
            deadLetterQueue: {
                queue: dlq,
                maxReceiveCount: config.sqs.maxReceiveCount,
            },
        });
    }

    /**
     * Create CloudWatch monitoring for queues
     */
    private createCloudWatchMonitoring(config: EnvironmentConfig): void {
        const queues = [
            { queue: this.backgroundJobQueue, name: 'background-job' },
            { queue: this.dataRefreshQueue, name: 'data-refresh' },
            { queue: this.notificationQueue, name: 'notification' },
        ];

        queues.forEach(({ queue, name }) => {
            // Queue depth alarm
            new cloudwatch.Alarm(this, `${this.toPascalCase(name)}QueueDepthAlarm`, {
                alarmName: generateResourceName(`${name}-queue-depth-alarm`, config.environment),
                alarmDescription: `High queue depth for ${name} queue`,
                metric: queue.metricApproximateNumberOfMessagesVisible(),
                threshold: config.monitoring.thresholds.sqsQueueDepth,
                evaluationPeriods: 2,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });

            // Dead letter queue alarm
            const dlqQueue =
                name === 'background-job'
                    ? this.backgroundJobDlq
                    : name === 'data-refresh'
                    ? this.dataRefreshDlq
                    : this.notificationDlq;

            new cloudwatch.Alarm(this, `${this.toPascalCase(name)}DlqAlarm`, {
                alarmName: generateResourceName(`${name}-dlq-alarm`, config.environment),
                alarmDescription: `Messages in ${name} dead letter queue`,
                metric: dlqQueue.metricApproximateNumberOfMessagesVisible(),
                threshold: 1, // Always alert on any DLQ messages
                evaluationPeriods: 1,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });

            // Message age alarm (for message processing delays)
            new cloudwatch.Alarm(this, `${this.toPascalCase(name)}MessageAgeAlarm`, {
                alarmName: generateResourceName(`${name}-message-age-alarm`, config.environment),
                alarmDescription: `Old messages in ${name} queue`,
                metric: queue.metricApproximateAgeOfOldestMessage(),
                threshold: config.monitoring.thresholds.sqsMessageAge,
                evaluationPeriods: 2,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
        });
    }

    /**
     * Create IAM policy for queue access
     */
    public createQueueAccessPolicy(): iam.PolicyDocument {
        return new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'sqs:SendMessage',
                        'sqs:ReceiveMessage',
                        'sqs:DeleteMessage',
                        'sqs:GetQueueAttributes',
                        'sqs:GetQueueUrl',
                        'sqs:ChangeMessageVisibility',
                    ],
                    resources: [
                        this.backgroundJobQueue.queueArn,
                        this.dataRefreshQueue.queueArn,
                        this.notificationQueue.queueArn,
                    ],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['sqs:GetQueueAttributes', 'sqs:SendMessage'],
                    resources: [
                        this.backgroundJobDlq.queueArn,
                        this.dataRefreshDlq.queueArn,
                        this.notificationDlq.queueArn,
                    ],
                }),
            ],
        });
    }

    /**
     * Apply consistent tags to all resources
     */
    private applyTags(config: EnvironmentConfig): void {
        const queues = [
            this.backgroundJobQueue,
            this.backgroundJobDlq,
            this.dataRefreshQueue,
            this.dataRefreshDlq,
            this.notificationQueue,
            this.notificationDlq,
        ];

        queues.forEach((queue) => {
            Object.entries(config.tags).forEach(([key, value]) => {
                cdk.Tags.of(queue).add(key, value);
            });
            cdk.Tags.of(queue).add('Stack', 'SQS');
        });
    }


    /**
     * Convert kebab-case to PascalCase for construct IDs
     */
    private toPascalCase(str: string): string {
        return str
            .split('-')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join('');
    }
}
