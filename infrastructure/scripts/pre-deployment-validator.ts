#!/usr/bin/env ts-node

import { Command } from 'commander';
import { ECSClient, DescribeServicesCommand, DescribeClustersCommand } from '@aws-sdk/client-ecs';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { loadEnvironmentConfig, normalizeEnvironmentName } from '../config/environments/shared';
import chalk from 'chalk';

interface ValidationResult {
    check: string;
    status: 'PASS' | 'FAIL' | 'WARN';
    message: string;
    critical: boolean;
}

interface ValidationSummary {
    environment: string;
    timestamp: Date;
    results: ValidationResult[];
    criticalFailures: number;
    warnings: number;
    canDeploy: boolean;
}

class PreDeploymentValidator {
    private ecsClient: ECSClient;
    private cfClient: CloudFormationClient;
    private rdsClient: RDSClient;
    private secretsClient: SecretsManagerClient;
    private sqsClient: SQSClient;
    private stsClient: STSClient;
    private environment: string;
    private region: string;

    constructor(environment: string, region: string = 'us-east-1') {
        this.environment = normalizeEnvironmentName(environment);
        this.region = region;
        this.ecsClient = new ECSClient({ region });
        this.cfClient = new CloudFormationClient({ region });
        this.rdsClient = new RDSClient({ region });
        this.secretsClient = new SecretsManagerClient({ region });
        this.sqsClient = new SQSClient({ region });
        this.stsClient = new STSClient({ region });
    }

    async validate(): Promise<ValidationSummary> {
        console.log(chalk.blue(`🔍 Pre-deployment validation for ${this.environment} environment...`));
        
        const results: ValidationResult[] = [];
        
        // Critical infrastructure checks
        results.push(...await this.validateInfrastructure());
        
        // Database health checks
        results.push(...await this.validateDatabase());
        
        // Secrets availability
        results.push(...await this.validateSecrets());
        
        // Queue health
        results.push(...await this.validateQueues());
        
        // Service health and capacity
        results.push(...await this.validateServices());
        
        // Environment-specific checks
        results.push(...await this.validateEnvironmentSpecific());

        const criticalFailures = results.filter(r => r.status === 'FAIL' && r.critical).length;
        const warnings = results.filter(r => r.status === 'WARN').length;
        const canDeploy = criticalFailures === 0;

        return {
            environment: this.environment,
            timestamp: new Date(),
            results,
            criticalFailures,
            warnings,
            canDeploy,
        };
    }

    private async validateInfrastructure(): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];
        
        const stackNames = [
            `v3-backend-${this.environment}-networking`,
            `v3-backend-${this.environment}-database`,
            `v3-backend-${this.environment}-security`,
            `v3-backend-${this.environment}-sqs`,
            `v3-backend-${this.environment}-compute`,
        ];

        for (const stackName of stackNames) {
            try {
                const response = await this.cfClient.send(
                    new DescribeStacksCommand({ StackName: stackName })
                );
                
                const stack = response.Stacks?.[0];
                if (!stack) {
                    results.push({
                        check: `CloudFormation-${stackName}`,
                        status: 'FAIL',
                        message: `Stack ${stackName} not found`,
                        critical: true,
                    });
                    continue;
                }

                const status = stack.StackStatus;
                if (status?.includes('COMPLETE')) {
                    results.push({
                        check: `CloudFormation-${stackName}`,
                        status: 'PASS',
                        message: `Stack ${stackName}: ${status}`,
                        critical: false,
                    });
                } else if (status?.includes('IN_PROGRESS')) {
                    results.push({
                        check: `CloudFormation-${stackName}`,
                        status: 'FAIL',
                        message: `Stack ${stackName} is in progress: ${status}. Wait for completion.`,
                        critical: true,
                    });
                } else if (status?.includes('FAILED')) {
                    results.push({
                        check: `CloudFormation-${stackName}`,
                        status: 'FAIL',
                        message: `Stack ${stackName} is in failed state: ${status}`,
                        critical: stackName.includes('compute'), // Compute stack failures are critical
                    });
                } else {
                    results.push({
                        check: `CloudFormation-${stackName}`,
                        status: 'WARN',
                        message: `Stack ${stackName} has unexpected status: ${status}`,
                        critical: false,
                    });
                }
            } catch (error) {
                results.push({
                    check: `CloudFormation-${stackName}`,
                    status: 'FAIL',
                    message: `Failed to check stack ${stackName}: ${error}`,
                    critical: true,
                });
            }
        }

        return results;
    }

    private async validateDatabase(): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];
        const dbInstanceId = `v3-backend-${this.environment}-database`;

        try {
            const response = await this.rdsClient.send(
                new DescribeDBInstancesCommand({
                    DBInstanceIdentifier: dbInstanceId,
                })
            );

            const instance = response.DBInstances?.[0];
            if (!instance) {
                results.push({
                    check: 'Database-Instance',
                    status: 'FAIL',
                    message: `Database instance ${dbInstanceId} not found`,
                    critical: true,
                });
                return results;
            }

            if (instance.DBInstanceStatus === 'available') {
                results.push({
                    check: 'Database-Instance',
                    status: 'PASS',
                    message: `Database ${dbInstanceId} is available`,
                    critical: false,
                });
            } else {
                results.push({
                    check: 'Database-Instance',
                    status: 'FAIL',
                    message: `Database ${dbInstanceId} status: ${instance.DBInstanceStatus}`,
                    critical: true,
                });
            }

            // Check backup window timing
            const now = new Date();
            const hour = now.getUTCHours();
            const backupWindow = instance.PreferredBackupWindow;
            
            if (backupWindow) {
                const [startHour] = backupWindow.split('-')[0].split(':').map(Number);
                const [endHour] = backupWindow.split('-')[1].split(':').map(Number);
                
                if (hour >= startHour && hour <= endHour) {
                    results.push({
                        check: 'Database-BackupWindow',
                        status: 'WARN',
                        message: `Current time is within backup window (${backupWindow} UTC). Deployment may impact performance.`,
                        critical: false,
                    });
                } else {
                    results.push({
                        check: 'Database-BackupWindow',
                        status: 'PASS',
                        message: `Deployment time is outside backup window (${backupWindow} UTC)`,
                        critical: false,
                    });
                }
            }

        } catch (error) {
            results.push({
                check: 'Database-Instance',
                status: 'FAIL',
                message: `Failed to check database: ${error}`,
                critical: true,
            });
        }

        return results;
    }

    private async validateSecrets(): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];
        const secretNames = [
            `v3-backend/${this.environment}/config`,
            `v3-backend-${this.environment}-db-credentials`,
        ];

        for (const secretName of secretNames) {
            try {
                await this.secretsClient.send(
                    new GetSecretValueCommand({ SecretId: secretName })
                );
                
                results.push({
                    check: `Secret-${secretName}`,
                    status: 'PASS',
                    message: `Secret ${secretName} is accessible`,
                    critical: false,
                });
            } catch (error: any) {
                const isCritical = secretName.includes('config'); // Config secret is critical
                results.push({
                    check: `Secret-${secretName}`,
                    status: 'FAIL',
                    message: `Secret ${secretName} not accessible: ${error.message}`,
                    critical: isCritical,
                });
            }
        }

        return results;
    }

    private async validateQueues(): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];
        const queueNames = [
            `v3-backend-${this.environment}-background-job-queue`,
            `v3-backend-${this.environment}-data-refresh-queue`,
            `v3-backend-${this.environment}-notification-queue`,
        ];

        for (const queueName of queueNames) {
            try {
                const queueUrl = `https://sqs.${this.region}.amazonaws.com/${await this.getAccountId()}/${queueName}`;
                
                const response = await this.sqsClient.send(
                    new GetQueueAttributesCommand({
                        QueueUrl: queueUrl,
                        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
                    })
                );

                const visibleMessages = parseInt(response.Attributes?.['ApproximateNumberOfMessages'] || '0');
                const inFlightMessages = parseInt(response.Attributes?.['ApproximateNumberOfMessagesNotVisible'] || '0');
                
                if (visibleMessages > 1000) {
                    results.push({
                        check: `Queue-${queueName}`,
                        status: 'WARN',
                        message: `Queue ${queueName} has ${visibleMessages} messages. Consider processing before deployment.`,
                        critical: false,
                    });
                } else {
                    results.push({
                        check: `Queue-${queueName}`,
                        status: 'PASS',
                        message: `Queue ${queueName}: ${visibleMessages} visible, ${inFlightMessages} in-flight`,
                        critical: false,
                    });
                }

            } catch (error) {
                results.push({
                    check: `Queue-${queueName}`,
                    status: 'FAIL',
                    message: `Failed to check queue ${queueName}: ${error}`,
                    critical: false, // Queue issues are not deployment-blocking
                });
            }
        }

        return results;
    }

    private async validateServices(): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];
        const clusterName = `v3-backend-${this.environment}-cluster`;
        
        try {
            // Check cluster
            const clusterResponse = await this.ecsClient.send(
                new DescribeClustersCommand({ clusters: [clusterName] })
            );
            
            const cluster = clusterResponse.clusters?.[0];
            if (!cluster || cluster.status !== 'ACTIVE') {
                results.push({
                    check: 'ECS-Cluster',
                    status: 'FAIL',
                    message: `Cluster ${clusterName} is not active`,
                    critical: true,
                });
                return results; // Can't check services if cluster is down
            }

            results.push({
                check: 'ECS-Cluster',
                status: 'PASS',
                message: `Cluster ${clusterName} is active`,
                critical: false,
            });

            // Check services
            const serviceNames = [
                `v3-backend-${this.environment}-api-service`,
                `v3-backend-${this.environment}-worker-service`,
                `v3-backend-${this.environment}-scheduler-service`,
            ];

            const servicesResponse = await this.ecsClient.send(
                new DescribeServicesCommand({
                    cluster: clusterName,
                    services: serviceNames,
                })
            );

            for (const service of servicesResponse.services || []) {
                const serviceName = service.serviceName!;
                const running = service.runningCount || 0;
                const desired = service.desiredCount || 0;
                
                if (running === 0 && desired > 0) {
                    results.push({
                        check: `Service-${serviceName}`,
                        status: 'FAIL',
                        message: `Service ${serviceName} has 0 running tasks but ${desired} desired. Service is down.`,
                        critical: true,
                    });
                } else if (running < desired) {
                    results.push({
                        check: `Service-${serviceName}`,
                        status: 'WARN',
                        message: `Service ${serviceName}: ${running}/${desired} tasks running. Service is degraded.`,
                        critical: false,
                    });
                } else {
                    results.push({
                        check: `Service-${serviceName}`,
                        status: 'PASS',
                        message: `Service ${serviceName}: ${running}/${desired} tasks running`,
                        critical: false,
                    });
                }
            }

        } catch (error) {
            results.push({
                check: 'ECS-Services',
                status: 'FAIL',
                message: `Failed to check ECS services: ${error}`,
                critical: true,
            });
        }

        return results;
    }

    private async validateEnvironmentSpecific(): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];
        
        try {
            const config = await loadEnvironmentConfig(this.environment);
            
            // Validate minimum instances for the environment
            const minInstances = config.autoScaling?.minInstances || 1;
            if (this.environment === 'production' && minInstances < 2) {
                results.push({
                    check: 'Production-MinInstances',
                    status: 'WARN',
                    message: `Production environment has only ${minInstances} minimum instances. Consider increasing for HA.`,
                    critical: false,
                });
            }

            // Check if it's a high-traffic time for production
            if (this.environment === 'production') {
                const hour = new Date().getUTCHours();
                const isBusinessHours = hour >= 14 && hour <= 22; // 9 AM - 5 PM EST/EDT
                
                if (isBusinessHours) {
                    results.push({
                        check: 'Production-BusinessHours',
                        status: 'WARN',
                        message: 'Deploying during business hours. Consider scheduling during off-peak times.',
                        critical: false,
                    });
                } else {
                    results.push({
                        check: 'Production-BusinessHours',
                        status: 'PASS',
                        message: 'Deployment scheduled during off-peak hours',
                        critical: false,
                    });
                }
            }

            results.push({
                check: 'Environment-Config',
                status: 'PASS',
                message: `Environment configuration loaded successfully`,
                critical: false,
            });

        } catch (error) {
            results.push({
                check: 'Environment-Config',
                status: 'FAIL',
                message: `Failed to load environment configuration: ${error}`,
                critical: true,
            });
        }

        return results;
    }

    private async getAccountId(): Promise<string> {
        try {
            const result = await this.stsClient.send(new GetCallerIdentityCommand({}));
            return result.Account || '123456789012';
        } catch (error) {
            console.warn('Could not get AWS account ID, using placeholder');
            return '123456789012';
        }
    }

    formatReport(summary: ValidationSummary): void {
        console.log(chalk.blue('\n📋 PRE-DEPLOYMENT VALIDATION REPORT'));
        console.log(chalk.blue('═'.repeat(60)));
        
        console.log(`Environment: ${summary.environment}`);
        console.log(`Timestamp: ${summary.timestamp.toISOString()}`);
        console.log(`Can Deploy: ${summary.canDeploy ? chalk.green('✅ YES') : chalk.red('❌ NO')}`);
        
        if (summary.criticalFailures > 0) {
            console.log(chalk.red(`Critical Failures: ${summary.criticalFailures}`));
        }
        
        if (summary.warnings > 0) {
            console.log(chalk.yellow(`Warnings: ${summary.warnings}`));
        }

        console.log(chalk.blue('\n🔍 VALIDATION RESULTS:'));
        
        const grouped = {
            'FAIL': summary.results.filter(r => r.status === 'FAIL'),
            'WARN': summary.results.filter(r => r.status === 'WARN'),
            'PASS': summary.results.filter(r => r.status === 'PASS'),
        };

        for (const [status, results] of Object.entries(grouped)) {
            if (results.length === 0) continue;
            
            const icon = status === 'FAIL' ? '❌' : status === 'WARN' ? '⚠️' : '✅';
            const color = status === 'FAIL' ? chalk.red : status === 'WARN' ? chalk.yellow : chalk.green;
            
            console.log(color(`\n${icon} ${status} (${results.length}):`));
            
            for (const result of results) {
                const criticalMark = result.critical ? ' [CRITICAL]' : '';
                console.log(color(`  • ${result.check}: ${result.message}${criticalMark}`));
            }
        }

        if (!summary.canDeploy) {
            console.log(chalk.red('\n🚫 DEPLOYMENT BLOCKED'));
            console.log(chalk.red('Fix critical issues before deploying:'));
            
            const criticalIssues = summary.results.filter(r => r.status === 'FAIL' && r.critical);
            for (const issue of criticalIssues) {
                console.log(chalk.red(`  • ${issue.check}: ${issue.message}`));
            }
        } else {
            console.log(chalk.green('\n✅ DEPLOYMENT APPROVED'));
            if (summary.warnings > 0) {
                console.log(chalk.yellow('Consider addressing warnings before deployment.'));
            }
        }
    }
}

// CLI setup
const program = new Command();

program
    .name('pre-deployment-validator')
    .description('Validate environment before deployment')
    .option('-e, --env <environment>', 'Environment to validate', 'development')
    .option('-r, --region <region>', 'AWS region', 'us-east-1')
    .option('-j, --json', 'Output JSON format')
    .option('--fail-on-warnings', 'Fail validation if warnings are present', false);

program.parse();

const options = program.opts();

async function main() {
    try {
        const validator = new PreDeploymentValidator(options.env, options.region);
        const summary = await validator.validate();

        if (options.json) {
            console.log(JSON.stringify(summary, null, 2));
        } else {
            validator.formatReport(summary);
        }

        // Exit with appropriate code
        let exitCode = 0;
        if (!summary.canDeploy) {
            exitCode = 1; // Critical failures
        } else if (options.failOnWarnings && summary.warnings > 0) {
            exitCode = 2; // Warnings when --fail-on-warnings is set
        }

        process.exit(exitCode);
    } catch (error) {
        console.error(
            chalk.red('❌ Validation failed:'),
            error instanceof Error ? error.message : 'Unknown error'
        );
        process.exit(3);
    }
}

if (require.main === module) {
    main();
}