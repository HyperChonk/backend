#!/usr/bin/env ts-node

/**
 * Solution 3: Configuration Validation & Drift Detection
 * This script prevents configuration drift by validating consistency
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { loadEnvironmentConfig, normalizeEnvironmentName } from '../config/environments/shared';
import { Command } from 'commander';

interface ValidationResult {
    isValid: boolean;
    environment: string;
    driftDetected: ConfigDrift[];
    missingKeys: string[];
    extraKeys: string[];
}

interface ConfigDrift {
    key: string;
    cdkValue: any;
    secretsValue: any;
    severity: 'error' | 'warning' | 'info';
    description: string;
}

class ConfigurationValidator {
    private secretsManager: SecretsManagerClient;

    constructor(region: string) {
        this.secretsManager = new SecretsManagerClient({ region });
    }

    /**
     * ✅ Validate configuration consistency between CDK and Secrets Manager
     */
    async validateEnvironment(environment: string): Promise<ValidationResult> {
        console.log(`🔍 Validating ${environment} configuration...`);

        // Load CDK configuration
        const cdkConfig = await loadEnvironmentConfig(environment);

        // Get Secrets Manager configuration
        const secretsConfig = await this.getSecretsConfig(environment);

        // Build expected configuration from CDK
        const expectedConfig = {
            NODE_ENV: cdkConfig.environment === 'development' ? 'development' : cdkConfig.environment,
            LOG_LEVEL: cdkConfig.environment === 'development' ? 'debug' : 'info',
            AWS_REGION: cdkConfig.region,
            DEPLOYMENT_ENV: cdkConfig.environment,
            PORT: '4000',
            WORKER: 'false',
            SCHEDULER: 'false',
            AWS_ALERTS: cdkConfig.environment === 'production' ? 'true' : 'false',
        };

        // Validate configuration
        const driftDetected = this.detectDrift(expectedConfig, secretsConfig);
        const missingKeys = this.findMissingKeys(expectedConfig, secretsConfig);
        const extraKeys = this.findExtraKeys(expectedConfig, secretsConfig);

        return {
            isValid: driftDetected.length === 0 && missingKeys.length === 0,
            environment,
            driftDetected,
            missingKeys,
            extraKeys,
        };
    }

    /**
     * Get configuration from Secrets Manager
     */
    private async getSecretsConfig(environment: string): Promise<Record<string, any>> {
        try {
            const response = await this.secretsManager.send(
                new GetSecretValueCommand({
                    SecretId: `v3-backend/${environment}/config`,
                }),
            );

            return JSON.parse(response.SecretString || '{}');
        } catch (error) {
            console.warn(`⚠️  Could not retrieve secrets for ${environment}:`, error);
            return {};
        }
    }

    /**
     * Detect configuration drift
     */
    private detectDrift(expected: Record<string, any>, actual: Record<string, any>): ConfigDrift[] {
        const drift: ConfigDrift[] = [];

        Object.keys(expected).forEach((key) => {
            if (actual[key] !== expected[key]) {
                drift.push({
                    key,
                    cdkValue: expected[key],
                    secretsValue: actual[key] || '<not set>',
                    severity: this.getDriftSeverity(key),
                    description: this.getDriftDescription(key, expected[key], actual[key]),
                });
            }
        });

        return drift;
    }

    /**
     * Find missing keys in secrets
     */
    private findMissingKeys(expected: Record<string, any>, actual: Record<string, any>): string[] {
        return Object.keys(expected).filter((key) => !(key in actual));
    }

    /**
     * Find extra keys in secrets (not in CDK)
     */
    private findExtraKeys(expected: Record<string, any>, actual: Record<string, any>): string[] {
        const expectedKeys = new Set(Object.keys(expected));
        const sensitiveKeys = new Set([
            'DATABASE_URL',
            'ADMIN_API_KEY',
            'SENTRY_DSN',
            'SENTRY_AUTH_TOKEN',
            'THEGRAPH_API_KEY_FANTOM',
            'THEGRAPH_API_KEY_BALANCER',
            'SANITY_API_TOKEN',
            'DRPC_API_KEY',
            'DRPC_BEETS_API_KEY',
            'COINGECKO_API_KEY',
            'SATSUMA_API_KEY',
            'GRAFANA_CLOUD_LOKI_ENDPOINT',
            'GRAFANA_CLOUD_USER_ID',
            'GRAFANA_CLOUD_API_KEY',
            'SQS_BACKGROUND_JOB_QUEUE_URL',
            'SQS_DATA_REFRESH_QUEUE_URL',
            'SQS_NOTIFICATION_QUEUE_URL',
            'WHITELISTED_CHAINS', // Now managed entirely via AWS Secrets Manager
            'DEFAULT_CHAIN_ID', // Now managed entirely via AWS Secrets Manager
        ]);

        return Object.keys(actual).filter((key) => !expectedKeys.has(key) && !sensitiveKeys.has(key));
    }

    /**
     * Get drift severity based on key importance
     */
    private getDriftSeverity(key: string): 'error' | 'warning' | 'info' {
        const criticalKeys = ['NODE_ENV'];
        const warningKeys = ['AWS_REGION', 'DEPLOYMENT_ENV', 'LOG_LEVEL'];

        if (criticalKeys.includes(key)) return 'error';
        if (warningKeys.includes(key)) return 'warning';
        return 'info';
    }

    /**
     * Get drift description
     */
    private getDriftDescription(key: string, expected: any, actual: any): string {
        const descriptions: Record<string, string> = {
            NODE_ENV: 'Node.js environment setting mismatch',
            AWS_REGION: 'AWS region configuration drift',
            DEPLOYMENT_ENV: 'Deployment environment identifier mismatch',
            LOG_LEVEL: 'Logging level configuration drift',
        };

        return descriptions[key] || `Configuration value mismatch for ${key}`;
    }

    /**
     * ✅ Generate drift report
     */
    formatValidationReport(result: ValidationResult): string {
        let report = `\n🔍 Configuration Validation Report - ${result.environment.toUpperCase()}\n`;
        report += `${'='.repeat(50)}\n\n`;

        if (result.isValid) {
            report += '✅ Configuration is consistent\n';
            return report;
        }

        // Configuration drift
        if (result.driftDetected.length > 0) {
            report += '🚨 Configuration Drift Detected:\n';
            result.driftDetected.forEach((drift) => {
                const icon = drift.severity === 'error' ? '❌' : drift.severity === 'warning' ? '⚠️' : 'ℹ️';
                report += `  ${icon} ${drift.key}: ${drift.description}\n`;
                report += `     CDK:     ${drift.cdkValue}\n`;
                report += `     Secrets: ${drift.secretsValue}\n\n`;
            });
        }

        // Missing keys
        if (result.missingKeys.length > 0) {
            report += '📋 Missing Keys in Secrets Manager:\n';
            result.missingKeys.forEach((key) => {
                report += `  - ${key}\n`;
            });
            report += '\n';
        }

        // Extra keys
        if (result.extraKeys.length > 0) {
            report += '🔍 Extra Keys in Secrets Manager:\n';
            result.extraKeys.forEach((key) => {
                report += `  - ${key}\n`;
            });
            report += '\n';
        }

        // Remediation suggestions
        report += '🔧 Remediation Suggestions:\n';
        report += '  1. Update AWS Secrets Manager manually with correct values\n';
        report +=
            '  2. Use: aws secretsmanager update-secret --secret-id "v3-backend/' + result.environment + '/config"\n';
        report += '  3. Or update via AWS Console: Secrets Manager > v3-backend/' + result.environment + '/config\n';
        report += '  4. Verify with: npm run inspect-env-vars:' + result.environment + '\n';
        report += '  5. Redeploy the CDK stack if needed\n\n';

        return report;
    }

    /**
     * ✅ Validate all environments
     */
    async validateAllEnvironments(environments: string[]): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];

        for (const env of environments) {
            try {
                const result = await this.validateEnvironment(env);
                results.push(result);
            } catch (error) {
                console.error(`❌ Failed to validate ${env}:`, error);
                results.push({
                    isValid: false,
                    environment: env,
                    driftDetected: [],
                    missingKeys: [],
                    extraKeys: [],
                });
            }
        }

        return results;
    }

    /**
     * ✅ Integration with CI/CD pipeline
     */
    async validateForCICD(environment: string): Promise<number> {
        const result = await this.validateEnvironment(environment);

        console.log(this.formatValidationReport(result));

        // Count critical errors
        const criticalErrors = result.driftDetected.filter((drift) => drift.severity === 'error').length;

        if (criticalErrors > 0) {
            console.error(`❌ ${criticalErrors} critical configuration errors found`);
            return 1; // Exit code 1 for CI/CD failure
        }

        if (result.driftDetected.length > 0) {
            console.warn(`⚠️  ${result.driftDetected.length} configuration warnings found`);
        }

        return 0; // Exit code 0 for success
    }
}

// CLI Interface
const program = new Command();

program
    .name('validate-config-consistency')
    .description('Validate configuration consistency between CDK and Secrets Manager')
    .option('-e, --environment <env>', 'Environment name', 'development')
    .option('-r, --region <region>', 'AWS region', 'us-east-1')
    .option('--all', 'Validate all environments', false)
    .option('--ci', 'CI/CD mode (exits with error code on critical issues)', false)
    .action(async (options) => {
        const validator = new ConfigurationValidator(options.region);
        const normalizedEnvironment = normalizeEnvironmentName(options.environment);

        try {
            if (options.all) {
                const results = await validator.validateAllEnvironments(['development', 'staging', 'production']);
                results.forEach((result) => {
                    console.log(validator.formatValidationReport(result));
                });

                const hasErrors = results.some((result) => !result.isValid);
                process.exit(hasErrors ? 1 : 0);
            } else if (options.ci) {
                const exitCode = await validator.validateForCICD(normalizedEnvironment);
                process.exit(exitCode);
            } else {
                const result = await validator.validateEnvironment(normalizedEnvironment);
                console.log(validator.formatValidationReport(result));
                process.exit(result.isValid ? 0 : 1);
            }
        } catch (error) {
            console.error('❌ Validation failed:', error);
            process.exit(1);
        }
    });

if (require.main === module) {
    program.parse();
}
