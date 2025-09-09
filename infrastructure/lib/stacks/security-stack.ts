import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/shared/types';
import { SecurityGroups } from '../constructs/security-groups';
import { getSsmParameterName } from '../../config/environments/shared';

export interface SecurityStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
    vpc: ec2.IVpc;
}

/**
 * Security Stack for Balancer v3 Backend
 *
 * Creates security groups and exports their IDs via SSM Parameter Store.
 * Depends on NetworkingStack being deployed first.
 */
export class SecurityStack extends cdk.Stack {
    public readonly securityGroups: SecurityGroups;

    constructor(scope: Construct, id: string, props: SecurityStackProps) {
        super(scope, id, props);

        const { config, vpc } = props;

        // Create security groups
        this.securityGroups = new SecurityGroups(this, 'SecurityGroups', {
            vpc,
            config,
        });

        // Export security group configuration to SSM parameters for migration script
        this.createSsmOutputs(config);

        // Apply tags
        this.applyTags(config);
    }

    /**
     * Apply consistent tags to all resources
     */
    private applyTags(config: EnvironmentConfig): void {
        Object.entries(config.tags).forEach(([key, value]) => {
            cdk.Tags.of(this).add(key, value);
        });
        cdk.Tags.of(this).add('Stack', 'Security');
    }

    private createSsmOutputs(config: EnvironmentConfig): void {
        // Export ECS security group ID for migration script
        new ssm.StringParameter(this, 'EcsSgId', {
            parameterName: getSsmParameterName('security', 'ecsSgId', config.environment),
            stringValue: this.securityGroups.ecsSecurityGroup.securityGroupId,
            description: `ECS security group ID for ${config.environment} environment`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // Export other security group IDs for future use
        new ssm.StringParameter(this, 'AlbSgId', {
            parameterName: getSsmParameterName('security', 'albSgId', config.environment),
            stringValue: this.securityGroups.albSecurityGroup.securityGroupId,
            description: `ALB security group ID for ${config.environment} environment`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'DbSgId', {
            parameterName: getSsmParameterName('security', 'dbSgId', config.environment),
            stringValue: this.securityGroups.databaseSecurityGroup.securityGroupId,
            description: `Database security group ID for ${config.environment} environment`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'VpceSgId', {
            parameterName: getSsmParameterName('security', 'vpceSgId', config.environment),
            stringValue: this.securityGroups.vpcEndpointSecurityGroup.securityGroupId,
            description: `VPC endpoint security group ID for ${config.environment} environment`,
            tier: ssm.ParameterTier.STANDARD,
        });
    }
}
