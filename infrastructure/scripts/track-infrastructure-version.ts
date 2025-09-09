#!/usr/bin/env ts-node

import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

interface InfrastructureVersionInfo {
    version: string;
    gitCommit: {
        hash: string;
        shortHash: string;
    };
    deployedAt: string;
    environment: string;
}

async function trackInfrastructureVersion(environment: string, region: string = 'us-east-1'): Promise<void> {
    try {
        // Read version from package.json
        const packageJsonPath = join(__dirname, '..', 'package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        const version = packageJson.version;

        // Get git information
        let gitHash: string;
        let gitShortHash: string;
        
        try {
            gitHash = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
            gitShortHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
        } catch (error) {
            console.warn('⚠️ Could not get git information, using fallback values');
            gitHash = 'unknown';
            gitShortHash = 'unknown';
        }

        // Create version info object
        const versionInfo: InfrastructureVersionInfo = {
            version,
            gitCommit: {
                hash: gitHash,
                shortHash: gitShortHash,
            },
            deployedAt: new Date().toISOString(),
            environment,
        };

        // Store in SSM Parameter
        const ssmClient = new SSMClient({ region });
        const parameterName = `/v3-backend/${environment}/infrastructure/version`;

        try {
            // First try to create the parameter with tags (for new parameters)
            await ssmClient.send(
                new PutParameterCommand({
                    Name: parameterName,
                    Value: JSON.stringify(versionInfo),
                    Type: 'String',
                    Description: `Infrastructure version information for ${environment} environment`,
                    Tags: [
                        {
                            Key: 'Environment',
                            Value: environment,
                        },
                        {
                            Key: 'Component',
                            Value: 'Infrastructure',
                        },
                        {
                            Key: 'UpdatedBy',
                            Value: 'deployment-script',
                        },
                    ],
                })
            );
        } catch (error: any) {
            // If parameter already exists, update it without tags
            if (error.name === 'ParameterAlreadyExists') {
                await ssmClient.send(
                    new PutParameterCommand({
                        Name: parameterName,
                        Value: JSON.stringify(versionInfo),
                        Type: 'String',
                        Overwrite: true,
                        Description: `Infrastructure version information for ${environment} environment`,
                    })
                );
            } else {
                throw error;
            }
        }

        console.log(`✅ Infrastructure version tracked successfully:`);
        console.log(`   Parameter: ${parameterName}`);
        console.log(`   Version: ${version}`);
        console.log(`   Git Hash: ${gitShortHash}`);
        console.log(`   Environment: ${environment}`);
        console.log(`   Deployed At: ${versionInfo.deployedAt}`);

    } catch (error) {
        console.error('❌ Failed to track infrastructure version:', error);
        // Don't fail the deployment if version tracking fails
        console.warn('⚠️ Continuing deployment despite version tracking failure');
    }
}

// CLI interface
if (require.main === module) {
    const environment = process.argv[2];
    const region = process.argv[3] || 'us-east-1';

    if (!environment) {
        console.error('Usage: ts-node track-infrastructure-version.ts <environment> [region]');
        console.error('Example: ts-node track-infrastructure-version.ts development us-east-1');
        process.exit(1);
    }

    trackInfrastructureVersion(environment, region)
        .then(() => {
            console.log('Infrastructure version tracking completed');
        })
        .catch((error) => {
            console.error('Infrastructure version tracking failed:', error);
            process.exit(1);
        });
}

export { trackInfrastructureVersion };