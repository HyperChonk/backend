#!/usr/bin/env ts-node

/**
 * Show Configuration Template for Secrets Manager
 *
 * This script shows the expected JSON structure for the Secrets Manager secret
 * based on the CDK configuration for each environment.
 */

import { Command } from 'commander';
import { loadEnvironmentConfig } from '../config/environments/shared';

interface ConfigTemplate {
    environment: string;
    template: Record<string, any>;
    description: string;
}

class ConfigTemplateGenerator {
    /**
     * ✅ Generate configuration template for an environment
     */
    async generateTemplate(environment: string): Promise<ConfigTemplate> {
        const config = await loadEnvironmentConfig(environment);

        // Build the expected configuration template
        const template = {
            // 🔧 Infrastructure Configuration (from CDK config)
            NODE_ENV: config.environment === 'development' ? 'development' : config.environment,
            LOG_LEVEL: config.environment === 'development' ? 'debug' : 'info',
            AWS_REGION: config.region,
            DEPLOYMENT_ENV: config.environment,
            AWS_ALERTS: config.environment === 'production' ? 'true' : 'false',

            // 🔧 Application Configuration
            PORT: '4000',
            WORKER: 'false', // Override per container type
            SCHEDULER: 'false', // Override per container type

            // 🔧 Dynamic Queue URLs (updated by CDK or post-deployment)
            SQS_BACKGROUND_JOB_QUEUE_URL:
                'https://sqs.us-east-1.amazonaws.com/ACCOUNT/v3-backend-development-background-job-queue',
            SQS_DATA_REFRESH_QUEUE_URL:
                'https://sqs.us-east-1.amazonaws.com/ACCOUNT/v3-backend-development-data-refresh-queue',
            SQS_NOTIFICATION_QUEUE_URL:
                'https://sqs.us-east-1.amazonaws.com/ACCOUNT/v3-backend-development-notification-queue',

            // 🔒 Sensitive Configuration (managed manually)
            DATABASE_URL: 'postgresql://user:password@host:5432/database',
            ADMIN_API_KEY: 'your-secure-admin-key-here',
            SANITY_API_TOKEN: 'your-sanity-token-or-empty-string',
            SENTRY_DSN: 'your-sentry-dsn-or-empty-string',
            SENTRY_AUTH_TOKEN: 'your-sentry-auth-token-or-empty-string',
            SENTRY_TRACES_SAMPLE_RATE: config.environment === 'production' ? '1.0' : '0.1',
            SENTRY_PROFILES_SAMPLE_RATE: config.environment === 'production' ? '1.0' : '0.1',

            // 🔒 API Keys (managed manually)
            THEGRAPH_API_KEY_FANTOM: 'your-thegraph-fantom-key-or-empty-string',
            THEGRAPH_API_KEY_BALANCER: 'your-thegraph-balancer-key-or-empty-string',
            DRPC_API_KEY: 'your-drpc-key-or-empty-string',
            DRPC_BEETS_API_KEY: 'your-drpc-beets-key-or-empty-string',
            COINGECKO_API_KEY: 'your-coingecko-key-or-empty-string',
            SATSUMA_API_KEY: 'your-satsuma-key-or-empty-string',

            // 🔒 Optional Monitoring (managed manually)
            GRAFANA_CLOUD_LOKI_ENDPOINT: '',
            GRAFANA_CLOUD_USER_ID: '',
            GRAFANA_CLOUD_API_KEY: '',

            // 🎯 Add any custom configuration here without CDK changes!
            // All keys automatically become environment variables in your containers
            // NEW_FEATURE_ENABLED: 'true',
            // CUSTOM_API_ENDPOINT: 'https://api.example.com',
            // REDIS_URL: 'redis://localhost:6379',
        };

        return {
            environment,
            template,
            description: `Configuration template for ${environment} environment`,
        };
    }

    /**
     * ✅ Format template as JSON for AWS CLI
     */
    formatForAwsCli(template: ConfigTemplate): string {
        return JSON.stringify(template.template, null, 2);
    }

    /**
     * ✅ Format template as readable documentation
     */
    formatAsDocumentation(template: ConfigTemplate): string {
        let output = `\n📋 Configuration Template - ${template.environment.toUpperCase()}\n`;
        output += `${'='.repeat(50)}\n\n`;

        output += `🎯 Secret Name: v3-backend/${template.environment}/config\n\n`;

        output += `📦 Infrastructure Configuration (from CDK):\n`;
        const infraKeys = [
            'NODE_ENV',
            'LOG_LEVEL',
            'AWS_REGION',
            'DEPLOYMENT_ENV',
            'AWS_ALERTS',
        ];
        infraKeys.forEach((key) => {
            if (template.template[key] !== undefined) {
                output += `  ${key}: ${template.template[key]}\n`;
            }
        });

        output += `\n🔧 Application Configuration:\n`;
        const appKeys = ['PORT', 'WORKER', 'SCHEDULER'];
        appKeys.forEach((key) => {
            if (template.template[key] !== undefined) {
                output += `  ${key}: ${template.template[key]}\n`;
            }
        });

        output += `\n🔗 Queue URLs (auto-populated by CDK):\n`;
        const queueKeys = Object.keys(template.template).filter((k) => k.includes('SQS_'));
        queueKeys.forEach((key) => {
            output += `  ${key}: ${template.template[key]}\n`;
        });

        output += `\n🔒 Sensitive Configuration (manually managed):\n`;
        const sensitiveKeys = Object.keys(template.template).filter(
            (k) => !infraKeys.includes(k) && !appKeys.includes(k) && !queueKeys.includes(k),
        );
        sensitiveKeys.forEach((key) => {
            output += `  ${key}: ${template.template[key]}\n`;
        });

        output += `\n📝 Usage Instructions:\n`;
        output += `  1. Update the secret in AWS Console or via CLI:\n`;
        output += `     aws secretsmanager update-secret --secret-id "v3-backend/${template.environment}/config" --secret-string file://config.json\n\n`;
        output += `  2. Your application receives ALL keys as environment variables automatically:\n`;
        output += `     - process.env.DATABASE_URL\n`;
        output += `     - process.env.NODE_ENV\n`;
        output += `     - process.env.WHITELISTED_CHAINS (manage via AWS Secrets Manager)\n`;
        output += `     - process.env.DEFAULT_CHAIN_ID (manage via AWS Secrets Manager)\n`;
        output += `     - process.env.THEGRAPH_API_KEY_BALANCER\n\n`;
        output += `  3. Add new configuration keys anytime without CDK changes!\n`;
        output += `     Just add them to the JSON and deploy - they become env vars automatically.\n\n`;

        return output;
    }

    /**
     * ✅ Show differences between current and expected configuration
     */
    async showDifferences(environment: string): Promise<void> {
        // This would require fetching current secrets, which we'll skip for now
        console.log(`💡 Use 'npm run validate-config:${environment}' to check differences with current configuration`);
    }
}

// CLI Interface
const program = new Command();

program
    .name('show-config-template')
    .description('Show configuration template for Secrets Manager')
    .option('-e, --environment <env>', 'Environment name', 'development')
    .option('-f, --format <format>', 'Output format (json|docs)', 'docs')
    .option('--aws-cli', 'Output format for AWS CLI usage', false)
    .action(async (options) => {
        const generator = new ConfigTemplateGenerator();

        try {
            const template = await generator.generateTemplate(options.environment);

            if (options.awsCli || options.format === 'json') {
                console.log(generator.formatForAwsCli(template));
            } else {
                console.log(generator.formatAsDocumentation(template));
            }
        } catch (error) {
            console.error('❌ Failed to generate template:', error);
            process.exit(1);
        }
    });

program
    .command('all')
    .description('Show templates for all environments')
    .option('-f, --format <format>', 'Output format (json|docs)', 'docs')
    .action(async (options) => {
        const generator = new ConfigTemplateGenerator();
        const environments = ['development', 'staging', 'production'];

        for (const env of environments) {
            try {
                const template = await generator.generateTemplate(env);

                if (options.format === 'json') {
                    console.log(`// ${env.toUpperCase()}`);
                    console.log(generator.formatForAwsCli(template));
                    console.log('');
                } else {
                    console.log(generator.formatAsDocumentation(template));
                }
            } catch (error) {
                console.error(`❌ Failed to generate template for ${env}:`, error);
            }
        }
    });

if (require.main === module) {
    program.parse();
}
