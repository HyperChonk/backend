import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/shared/types';
import { generateResourceName } from '../../config/environments/shared';

export interface LogForwarderStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
    // Use ARNs to decouple the stacks and prevent update/delete deadlocks
    logGroupArns: string[];
}

/**
 * Log Forwarder Stack for Grafana Cloud Integration
 *
 * Forwards all CloudWatch logs (application + infrastructure) directly to Grafana Cloud Loki.
 * No self-hosted services needed - everything goes to Grafana Cloud.
 */
export class LogForwarderStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: LogForwarderStackProps) {
        super(scope, id, props);

        const { config, logGroupArns } = props;

        // Reference your existing secrets manager secret
        const configSecret = secretsmanager.Secret.fromSecretNameV2(
            this,
            'ConfigSecret',
            `v3-backend/${config.environment}/config`,
        );

        // Create Lambda function that forwards logs to Grafana Cloud Loki
        const logForwarderFunction = new lambda.Function(this, 'GrafanaCloudForwarder', {
            functionName: generateResourceName('grafana-cloud-forwarder', config.environment),
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'handler.handler',
            timeout: cdk.Duration.minutes(2),
            memorySize: 256,
            environment: {
                ENVIRONMENT: config.environment,
                // Store the secret ARN and individual key names for runtime resolution
                SECRET_ARN: configSecret.secretArn,
                GRAFANA_CLOUD_LOKI_ENDPOINT_KEY: 'GRAFANA_CLOUD_LOKI_ENDPOINT',
                GRAFANA_CLOUD_USER_ID_KEY: 'GRAFANA_CLOUD_USER_ID',
                GRAFANA_CLOUD_API_KEY_KEY: 'GRAFANA_CLOUD_API_KEY',
            },
            code: lambda.Code.fromAsset(`${__dirname}/../lambda/log-forwarder`),
        });

        // Add permission for CloudWatch Logs to invoke the Lambda
        logForwarderFunction.addPermission('CloudWatchLogsInvoke', {
            principal: new iam.ServicePrincipal('logs.amazonaws.com'),
            action: 'lambda:InvokeFunction',
            sourceArn: `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
        });

        // Add permission to read from Secrets Manager (your existing pattern)
        logForwarderFunction.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
                resources: [`arn:aws:secretsmanager:${this.region}:*:secret:v3-backend/${config.environment}/*`],
            }),
        );

        // Create subscription filters for each log group from its ARN
        if (logGroupArns.length === 0) {
            console.warn('No valid log groups provided to LogForwarderStack - skipping subscription filter creation');
        }

        logGroupArns.forEach((logGroupArn, index) => {
            // Import the log group by ARN. This creates a reference without a hard dependency.
            const logGroup = logs.LogGroup.fromLogGroupArn(this, `ImportedLogGroup-${index}`, logGroupArn);

            // The logical ID of the subscription filter must be unique. Using the index is fine.
            new logs.SubscriptionFilter(this, `LogSubscription-${index}`, {
                logGroup, // Use the imported log group
                destination: new destinations.LambdaDestination(logForwarderFunction),
                filterPattern: logs.FilterPattern.allEvents(),
            });
        });

        // Create outputs
        new cdk.CfnOutput(this, 'LogForwarderFunctionName', {
            value: logForwarderFunction.functionName,
            description: 'Lambda function forwarding logs to Grafana Cloud',
            exportName: `${config.environment}-log-forwarder-function-name`,
        });

        new cdk.CfnOutput(this, 'LogGroupsForwarded', {
            value: logGroupArns.length.toString(),
            description: 'Number of log groups being forwarded to Grafana Cloud',
            exportName: `${config.environment}-log-groups-count`,
        });
    }
}
