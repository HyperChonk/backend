import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/shared/types';
import { generateResourceName } from '../../config/environments/shared';

export interface CertificateStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
    /** Domain name for the certificate. If provided, hostedZone is required. */
    domainName: string;
    /** Route53 hosted zone for DNS validation. */
    hostedZone: route53.IHostedZone;
}

/**
 * Certificate Stack for Balancer v3 Backend
 *
 * Creates and manages SSL/TLS certificates using AWS Certificate Manager (ACM).
 * This stack requires a Route53 hosted zone for automatic DNS validation.
 */
export class CertificateStack extends cdk.Stack {
    public readonly certificate: acm.ICertificate;

    constructor(scope: Construct, id: string, props: CertificateStackProps) {
        super(scope, id, props);

        const { config, domainName, hostedZone } = props;

        if (!hostedZone) {
            throw new Error(
                'A Route53 hosted zone must be provided for DNS validation. Email validation is not supported.',
            );
        }

        // Create the certificate with DNS validation
        // Note: CDK will wait for DNS validation by default, but our deployment script
        // will timeout after 5 minutes to prevent blocking deployments
        this.certificate = new acm.Certificate(this, 'DnsValidatedCertificate', {
            domainName,
            validation: acm.CertificateValidation.fromDns(hostedZone),
        });
        
        // Add metadata to track validation approach
        const cfnCertificate = this.certificate.node.defaultChild as acm.CfnCertificate;
        cfnCertificate.addMetadata('Environment', config.environment);
        cfnCertificate.addMetadata('DeploymentTimeout', '5-minutes');
        cfnCertificate.addMetadata('Note', 'Deployment script will timeout after 5 minutes to allow non-blocking deployments. Certificate may need manual validation after deployment.');

        // Apply tags
        Object.entries(config.tags).forEach(([key, value]) => {
            cdk.Tags.of(this.certificate).add(key, value);
        });

        cdk.Tags.of(this.certificate).add('Name', generateResourceName('certificate', config.environment));
        cdk.Tags.of(this.certificate).add('Domain', domainName);
        cdk.Tags.of(this.certificate).add('ValidationMethod', 'DNS');

    }

}
