#!/usr/bin/env ts-node

import { ACMClient, DescribeCertificateCommand, ListCertificatesCommand } from '@aws-sdk/client-acm';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import { Command } from 'commander';
import { normalizeEnvironmentName } from '../config/environments/shared';

const program = new Command();

interface EnvironmentDomains {
    apiDomain: string;
    rootDomain: string;
}

const ENVIRONMENT_DOMAINS: Record<string, EnvironmentDomains> = {
    development: {
        apiDomain: 'dev-api.hyperchonk.com',
        rootDomain: 'hyperchonk.com',
    },
    staging: {
        apiDomain: 'staging-api.hyperchonk.com',
        rootDomain: 'hyperchonk.com',
    },
    production: {
        apiDomain: 'api.hyperchonk.com',
        rootDomain: 'hyperchonk.com',
    },
};

interface DNSSettings {
    environment: string;
    nameServers: string[];
    apiDomain: string;
    rootDomain: string;
    hostedZoneId?: string;
    certificateArn?: string;
    certificateStatus?: string;
    certificateValidationRecords?: any[];
    loadBalancerDnsName?: string;
}

async function getStackOutputs(environment: string, stackName: string): Promise<Record<string, string>> {
    const cloudformation = new CloudFormationClient({ region: 'us-east-1' });

    try {
        const result = await cloudformation.send(
            new DescribeStacksCommand({
                StackName: `v3-backend-${environment}-${stackName}`,
            }),
        );

        const outputs: Record<string, string> = {};
        const stack = result.Stacks?.[0];

        if (stack?.Outputs) {
            for (const output of stack.Outputs) {
                if (output.OutputKey && output.OutputValue) {
                    outputs[output.OutputKey] = output.OutputValue;
                }
            }
        }

        return outputs;
    } catch (error) {
        console.warn(chalk.yellow(`Warning: Could not get ${stackName} stack outputs for ${environment}: ${error}`));
        return {};
    }
}

async function getNameServersFromSSM(environment: string): Promise<string[]> {
    const ssm = new SSMClient({ region: 'us-east-1' });

    try {
        const result = await ssm.send(
            new GetParameterCommand({
                Name: `/v3-backend/${environment}/dns/nameServers`,
            }),
        );

        if (result.Parameter?.Value) {
            return result.Parameter.Value.split(',').map((ns) => ns.trim());
        }
    } catch (error) {
        console.warn(chalk.yellow(`Warning: Could not get nameservers from SSM for ${environment}: ${error}`));
    }

    return [];
}

async function getCertificateInfo(
    environment: string,
    domain: string,
): Promise<{ arn?: string; status?: string; validationRecords?: any[] }> {
    const acm = new ACMClient({ region: 'us-east-1' });

    try {
        // List certificates and find the one for our domain
        const listResult = await acm.send(new ListCertificatesCommand({}));

        if (listResult.CertificateSummaryList) {
            for (const cert of listResult.CertificateSummaryList) {
                if (cert.DomainName === domain && cert.CertificateArn) {
                    // Get detailed certificate information
                    const describeResult = await acm.send(
                        new DescribeCertificateCommand({
                            CertificateArn: cert.CertificateArn,
                        }),
                    );

                    return {
                        arn: cert.CertificateArn,
                        status: describeResult.Certificate?.Status,
                        validationRecords: describeResult.Certificate?.DomainValidationOptions,
                    };
                }
            }
        }
    } catch (error) {
        console.warn(chalk.yellow(`Warning: Could not get certificate info for ${domain}: ${error}`));
    }

    return {};
}

async function getDNSSettings(environment: string): Promise<DNSSettings> {
    const domains = ENVIRONMENT_DOMAINS[environment];
    if (!domains) {
        throw new Error(`Unknown environment: ${environment}`);
    }

    // Get nameservers from multiple sources
    let nameServers: string[] = [];

    // Try to get from SSM first
    nameServers = await getNameServersFromSSM(environment);

    // If SSM failed, try CloudFormation outputs
    if (nameServers.length === 0) {
        const hostedZoneOutputs = await getStackOutputs(environment, 'hosted-zone');
        if (hostedZoneOutputs.NameServers) {
            nameServers = hostedZoneOutputs.NameServers.split(', ').map((ns) => ns.trim());
        }
    }

    // Get hosted zone ID
    const hostedZoneOutputs = await getStackOutputs(environment, 'hosted-zone');
    const hostedZoneId = hostedZoneOutputs.HostedZoneId;

    // Get certificate information
    const certInfo = await getCertificateInfo(environment, domains.apiDomain);

    // Get load balancer DNS name from compute stack
    const computeOutputs = await getStackOutputs(environment, 'compute');
    const loadBalancerDnsName = computeOutputs.LoadBalancerDnsName;

    return {
        environment,
        nameServers,
        apiDomain: domains.apiDomain,
        rootDomain: domains.rootDomain,
        hostedZoneId,
        certificateArn: certInfo.arn,
        certificateStatus: certInfo.status,
        certificateValidationRecords: certInfo.validationRecords,
        loadBalancerDnsName,
    };
}

function formatForGoDaddy(settings: DNSSettings): void {
    console.log(chalk.bold.blue(`\n🌐 DNS Settings for ${settings.environment.toUpperCase()} Environment`));
    console.log(chalk.gray('='.repeat(60)));

    console.log(chalk.bold.cyan('\n📋 GODADDY NAMESERVER SETUP:'));
    console.log(chalk.gray('Domain:'), chalk.white(settings.rootDomain));
    console.log(chalk.gray('Update nameservers to:'));

    if (settings.nameServers.length > 0) {
        settings.nameServers.forEach((ns, index) => {
            console.log(chalk.green(`  ${index + 1}. ${ns}`));
        });
    } else {
        console.log(chalk.red('  ❌ No nameservers found. Deploy the hosted-zone stack first.'));
    }

    console.log(chalk.bold.cyan('\n🏷️  CNAME RECORDS TO CREATE IN GODADDY:'));
    console.log(chalk.gray('(After nameservers are updated and propagated)'));

    if (settings.apiDomain !== settings.rootDomain) {
        const subdomain = settings.apiDomain.replace(`.${settings.rootDomain}`, '');
        console.log(chalk.yellow(`  Type: CNAME`));
        console.log(chalk.yellow(`  Name: ${subdomain}`));

        if (settings.loadBalancerDnsName) {
            console.log(chalk.yellow(`  Value: ${settings.loadBalancerDnsName}`));
        } else {
            console.log(chalk.yellow(`  Value: [Load Balancer DNS Name]`));
            console.log(chalk.gray(`  Note: Load balancer DNS will be available after compute stack deployment`));
        }
    }

    if (settings.certificateValidationRecords && settings.certificateValidationRecords.length > 0) {
        console.log(chalk.bold.cyan('\n🔒 SSL CERTIFICATE VALIDATION RECORDS:'));
        settings.certificateValidationRecords.forEach((record, index) => {
            if (record.ResourceRecord) {
                console.log(chalk.yellow(`  Record ${index + 1}:`));
                console.log(chalk.yellow(`    Type: CNAME`));
                console.log(chalk.yellow(`    Name: ${record.ResourceRecord.Name}`));
                console.log(chalk.yellow(`    Value: ${record.ResourceRecord.Value}`));
            }
        });
    }

    console.log(chalk.bold.cyan('\n📊 ENVIRONMENT DETAILS:'));
    console.log(chalk.gray('Environment:'), chalk.white(settings.environment));
    console.log(chalk.gray('API Domain:'), chalk.white(settings.apiDomain));
    console.log(chalk.gray('Root Domain:'), chalk.white(settings.rootDomain));

    if (settings.hostedZoneId) {
        console.log(chalk.gray('Hosted Zone ID:'), chalk.white(settings.hostedZoneId));
    }

    if (settings.certificateArn) {
        console.log(chalk.gray('Certificate ARN:'), chalk.white(settings.certificateArn));
        console.log(
            chalk.gray('Certificate Status:'),
            settings.certificateStatus === 'ISSUED'
                ? chalk.green(settings.certificateStatus)
                : settings.certificateStatus === 'PENDING_VALIDATION'
                ? chalk.yellow(settings.certificateStatus)
                : chalk.red(settings.certificateStatus || 'UNKNOWN'),
        );
    }

    if (settings.loadBalancerDnsName) {
        console.log(chalk.gray('Load Balancer DNS:'), chalk.white(settings.loadBalancerDnsName));
    }
}

function formatAsJSON(settings: DNSSettings): void {
    console.log(JSON.stringify(settings, null, 2));
}

function showInstructions(): void {
    console.log(chalk.bold.green('\n📝 SETUP INSTRUCTIONS:'));
    console.log(chalk.gray('='.repeat(60)));

    console.log(chalk.white('\n1. 🏗️  Deploy Infrastructure:'));
    console.log(chalk.gray('   npm run deploy:dev  (or staging/prod)'));

    console.log(chalk.white('\n2. 🌐 Update Nameservers in GoDaddy:'));
    console.log(chalk.gray('   - Login to GoDaddy DNS management'));
    console.log(chalk.gray('   - Select your domain (hyperchonk.com)'));
    console.log(chalk.gray('   - Replace existing nameservers with the ones shown above'));
    console.log(chalk.gray('   - Wait 24-48 hours for DNS propagation'));

    console.log(chalk.white('\n3. ✅ Verify Setup:'));
    console.log(chalk.gray('   - Check nameserver propagation: dig NS hyperchonk.com'));
    console.log(chalk.gray('   - Test API endpoint: curl https://dev-api.hyperchonk.com/health'));
    console.log(chalk.gray('   - Monitor certificate validation in AWS Console'));

    console.log(chalk.white('\n4. 🔄 Re-run This Script:'));
    console.log(chalk.gray('   - Run again after infrastructure changes'));
    console.log(chalk.gray('   - Use --json flag for CI/CD integration'));
}

async function main() {
    program
        .description('Get DNS/CNAME settings for GoDaddy configuration')
        .argument('[environment]', 'Environment (development, staging, production)', 'development')
        .option('--json', 'Output as JSON')
        .option('--instructions', 'Show detailed setup instructions')
        .action(async (environment: string, options) => {
            try {
                const normalizedEnvironment = normalizeEnvironmentName(environment);
                const validEnvironments = Object.keys(ENVIRONMENT_DOMAINS);
                if (!validEnvironments.includes(normalizedEnvironment)) {
                    console.error(chalk.red(`❌ Invalid environment. Must be one of: ${validEnvironments.join(', ')}`));
                    process.exit(1);
                }

                const settings = await getDNSSettings(normalizedEnvironment);

                if (options.json) {
                    formatAsJSON(settings);
                } else {
                    formatForGoDaddy(settings);

                    if (options.instructions) {
                        showInstructions();
                    }
                }
            } catch (error) {
                console.error(chalk.red(`❌ Error: ${error}`));
                process.exit(1);
            }
        });

    await program.parseAsync(process.argv);
}

if (require.main === module) {
    main().catch(console.error);
}
