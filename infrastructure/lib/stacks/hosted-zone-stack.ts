import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { generateResourceName, getSsmParameterName } from '../../config/environments/shared';
import { EnvironmentConfig } from '../../config/shared/types';

export interface HostedZoneStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
    /** Root domain name for the hosted zone (e.g., 'hyperchonk.com') */
    domainName: string;
}

/**
 * Hosted Zone Stack for Balancer v3 Backend
 *
 * Creates and manages Route53 hosted zones for DNS validation of SSL certificates.
 * This enables automatic certificate validation without manual email verification.
 */
export class HostedZoneStack extends cdk.Stack {
    public readonly hostedZone: route53.HostedZone;
    public readonly nameServers: string[];

    constructor(scope: Construct, id: string, props: HostedZoneStackProps) {
        super(scope, id, props);

        const { config, domainName } = props;

        // Create the hosted zone
        this.hostedZone = this.createHostedZone(config, domainName);

        // Ensure nameServers are available (they should always be for a newly created hosted zone)
        const nameServers = this.hostedZone.hostedZoneNameServers;
        if (!nameServers) {
            throw new Error('Failed to retrieve name servers from hosted zone');
        }
        this.nameServers = nameServers;

        // Export hosted zone information to SSM Parameter Store
        this.createSsmOutputs(config);

        // Create stack outputs for easy reference
        this.createOutputs(config, domainName);
    }

    /**
     * Create Route53 hosted zone
     */
    private createHostedZone(config: EnvironmentConfig, domainName: string): route53.HostedZone {
        const hostedZone = new route53.HostedZone(this, 'HostedZone', {
            zoneName: domainName,
            comment: `Hosted zone for ${config.environment} environment - ${domainName}`,
        });

        // Apply tags
        Object.entries(config.tags).forEach(([key, value]) => {
            cdk.Tags.of(hostedZone).add(key, value);
        });

        cdk.Tags.of(hostedZone).add('Name', generateResourceName('hosted-zone', config.environment));
        cdk.Tags.of(hostedZone).add('Domain', domainName);
        cdk.Tags.of(hostedZone).add('Purpose', 'DNS-Validation');

        return hostedZone;
    }

    /**
     * Create SSM Parameters for hosted zone information
     */
    private createSsmOutputs(config: EnvironmentConfig): void {
        const stackId = 'dns' as const;

        // Store nameservers for external configuration at domain registrar
        // Use CDK intrinsic function to handle nameServers token array
        new ssm.StringParameter(this, 'NameServersSsmParam', {
            parameterName: getSsmParameterName(stackId, 'nameServers', config.environment),
            stringValue: cdk.Fn.join(',', this.nameServers),
            description: `Name Servers for ${config.environment} (update these at your domain registrar)`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // Add tags to all parameters
        const parameters = this.node.findAll().filter((construct) => construct instanceof ssm.StringParameter);

        parameters.forEach((param) => {
            Object.entries(config.tags).forEach(([key, value]) => {
                cdk.Tags.of(param).add(key, value);
            });
            cdk.Tags.of(param).add('ParameterType', 'ExternalConfig');
        });
    }

    /**
     * Create CloudFormation outputs
     */
    private createOutputs(config: EnvironmentConfig, domainName: string): void {
        new cdk.CfnOutput(this, 'HostedZoneId', {
            value: this.hostedZone.hostedZoneId,
            description: `Route53 Hosted Zone ID for ${domainName}`,
            exportName: `${config.environment}-hosted-zone-id`,
        });

        new cdk.CfnOutput(this, 'HostedZoneName', {
            value: this.hostedZone.zoneName,
            description: `Route53 Hosted Zone Name for ${domainName}`,
            exportName: `${config.environment}-hosted-zone-name`,
        });

        new cdk.CfnOutput(this, 'NameServers', {
            value: cdk.Fn.join(', ', this.nameServers),
            description: `Name servers - UPDATE THESE AT YOUR DOMAIN REGISTRAR (${domainName})`,
            exportName: `${config.environment}-name-servers`,
        });

        // Create a special output with instructions
        new cdk.CfnOutput(this, 'SetupInstructions', {
            value: `Go to your domain registrar (GoDaddy) and update nameservers for ${domainName} to: ${cdk.Fn.join(
                ', ',
                this.nameServers,
            )}`,
            description: 'Setup instructions for DNS validation',
        });
    }
}
