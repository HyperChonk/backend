import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/shared/types';
import { generateResourceName, getSecretName } from '../../config/environments/shared';

export interface SecretsStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
    backgroundJobQueue?: sqs.Queue;
    dataRefreshQueue?: sqs.Queue;
    notificationQueue?: sqs.Queue;
}

export class SecretsStack extends cdk.Stack {
    public readonly configSecret: secretsmanager.ISecret;

    constructor(scope: Construct, id: string, props: SecretsStackProps) {
        super(scope, id, props);

        const { config, backgroundJobQueue, dataRefreshQueue, notificationQueue } = props;

        const secretName = getSecretName(config.environment, 'config');

        // Reference the existing secret (assume it exists or will be created manually)
        // This avoids the "already exists" error while still providing access
        this.configSecret = secretsmanager.Secret.fromSecretNameV2(this, 'ConfigSecret', secretName);

        // Apply tags to the stack (can't tag imported secrets directly)
        Object.entries(config.tags).forEach(([key, value]) => {
            cdk.Tags.of(this).add(key, value);
        });

        // Outputs
        new cdk.CfnOutput(this, 'ConfigSecretArn', {
            value: this.configSecret.secretArn,
            exportName: `${config.environment}-config-secret-arn`,
        });

        new cdk.CfnOutput(this, 'ConfigSecretName', {
            value: this.configSecret.secretName,
            exportName: `${config.environment}-config-secret-name`,
        });
    }
}
