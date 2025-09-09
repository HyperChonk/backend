#!/usr/bin/env ts-node

import { execSync } from 'child_process';
import chalk from 'chalk';
import { Route53Cleaner } from './cleanup-route53-records';

/**
 * Enhanced destroy script that automatically handles Route53 cleanup
 * This replaces the direct CDK destroy commands to prevent hosted zone deletion failures
 */
class DestroyWithCleanup {
    /**
     * Run a command and handle errors
     */
    private runCommand(command: string, description: string): boolean {
        try {
            console.log(chalk.blue(`🔄 ${description}...`));
            console.log(chalk.gray(`   Command: ${command}`));

            execSync(command, {
                stdio: 'inherit',
                cwd: __dirname + '/..',
                timeout: 30 * 60 * 1000, // 30 minute timeout
            });

            console.log(chalk.green(`✅ ${description} completed successfully`));
            return true;
        } catch (error: any) {
            console.error(chalk.red(`❌ ${description} failed: ${error.message}`));
            return false;
        }
    }

    /**
     * Check if AWS credentials are configured
     */
    private checkAwsCredentials(): boolean {
        try {
            execSync('aws sts get-caller-identity', { stdio: 'pipe' });
            return true;
        } catch {
            console.error(
                chalk.red(
                    '❌ AWS credentials not configured. Please run `aws configure` or set environment variables.',
                ),
            );
            return false;
        }
    }

    /**
     * Check if any stacks exist for this environment
     */
    private hasEnvironmentStacks(environment: string): boolean {
        try {
            const output = execSync(
                `aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --query 'StackSummaries[?starts_with(StackName, \`v3-backend-${environment}-\`)].StackName' --output text`,
                { encoding: 'utf8', stdio: 'pipe' },
            );

            return output.trim().length > 0;
        } catch (error) {
            // If we can't check, assume stacks exist and let CDK handle it
            return true;
        }
    }

    /**
     * Main destroy function with automatic Route53 cleanup
     */
    async destroyWithCleanup(environment: string): Promise<boolean> {
        console.log(chalk.blue(`🚀 Starting destroy for ${environment} environment`));

        // Check prerequisites
        if (!this.checkAwsCredentials()) {
            return false;
        }

        // Check if any stacks exist
        if (!this.hasEnvironmentStacks(environment)) {
            console.log(chalk.green('✅ No infrastructure found for this environment'));
            return true;
        }

        // Note: S3 bucket cleanup is handled automatically by CDK for non-production environments
        // Production buckets are retained as configured in the S3 stack

        // Attempt Route53 cleanup before CDK destroy
        console.log(chalk.blue('🧹 Checking for Route53 hosted zone cleanup...'));

        try {
            const cleaner = new Route53Cleaner();
            await cleaner.cleanupHostedZone(environment, false);
            console.log(chalk.green('✅ Route53 cleanup completed (or not needed)'));
        } catch (error: any) {
            console.warn(chalk.yellow(`⚠️  Route53 cleanup had issues: ${error.message}`));
            console.log(chalk.blue('🔄 Continuing with CDK destroy anyway...'));
        }

        // Execute CDK destroy
        console.log(chalk.blue('🗑️  Running CDK destroy...'));
        const cdkCommand = `cdk destroy --all -c environment=${environment} --force --no-notices`;
        const destroySuccess = this.runCommand(cdkCommand, 'CDK destroy');

        if (destroySuccess) {
            console.log(chalk.green('\n🎉 Environment destroyed successfully!'));
        } else {
            console.log(chalk.red('\n❌ Environment destruction failed'));
            console.log(chalk.yellow('💡 Check the error messages above for details'));
        }

        return destroySuccess;
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    const environment = args[0];

    if (!environment) {
        console.error(chalk.red('❌ Environment is required'));
        console.log(chalk.blue('Usage: ts-node destroy-with-cleanup.ts <environment>'));
        console.log(chalk.blue('Example: ts-node destroy-with-cleanup.ts staging'));
        process.exit(1);
    }

    if (!['development', 'staging', 'production'].includes(environment)) {
        console.error(chalk.red(`❌ Invalid environment: ${environment}`));
        console.log(chalk.blue('Valid environments: development, staging, production'));
        process.exit(1);
    }

    const destroyer = new DestroyWithCleanup();

    try {
        const success = await destroyer.destroyWithCleanup(environment);
        process.exit(success ? 0 : 1);
    } catch (error: any) {
        console.error(chalk.red(`❌ Unexpected error: ${error.message}`));
        process.exit(1);
    }
}

// Only run main if this file is executed directly
if (require.main === module) {
    main().catch((error) => {
        console.error(chalk.red('❌ Unexpected error:'), error);
        process.exit(1);
    });
}

export { DestroyWithCleanup };
