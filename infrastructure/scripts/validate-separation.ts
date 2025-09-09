#!/usr/bin/env node

import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { ECRClient, DescribeRepositoriesCommand, DescribeImagesCommand } from '@aws-sdk/client-ecr';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { program } from 'commander';
import { normalizeEnvironmentName } from '../config/environments/shared';

interface ValidationConfig {
    environment: string;
    region: string;
}

interface ValidationResult {
    test: string;
    status: 'PASS' | 'FAIL' | 'WARN';
    message: string;
    details?: any;
}

class SeparationValidator {
    private ecsClient: ECSClient;
    private ssmClient: SSMClient;
    private ecrClient: ECRClient;
    private cfnClient: CloudFormationClient;
    private results: ValidationResult[] = [];

    constructor(private config: ValidationConfig) {
        this.ecsClient = new ECSClient({ region: config.region });
        this.ssmClient = new SSMClient({ region: config.region });
        this.ecrClient = new ECRClient({ region: config.region });
        this.cfnClient = new CloudFormationClient({ region: config.region });
    }

    private addResult(test: string, status: 'PASS' | 'FAIL' | 'WARN', message: string, details?: any): void {
        this.results.push({ test, status, message, details });
        const emoji = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
        console.log(`${emoji} ${test}: ${message}`);
        if (details && status !== 'PASS') {
            console.log(`   Details: ${JSON.stringify(details, null, 2)}`);
        }
    }

    async validateDockerImageUri(): Promise<void> {
        try {
            console.log('\n🐳 Validating Docker Image URI Resolution...');

            // Check if ECR repository exists
            const repositories = await this.ecrClient.send(
                new DescribeRepositoriesCommand({
                    repositoryNames: ['balancer-api'],
                }),
            );

            if (repositories.repositories && repositories.repositories.length > 0) {
                this.addResult('ECR Repository', 'PASS', 'balancer-api repository exists');

                // Check for environment-specific tags
                const images = await this.ecrClient.send(
                    new DescribeImagesCommand({
                        repositoryName: 'balancer-api',
                        maxResults: 10,
                    }),
                );

                const envTag = `${this.config.environment}-latest`;
                const hasEnvTag = images.imageDetails?.some((img) => img.imageTags?.includes(envTag));

                if (hasEnvTag) {
                    this.addResult('Environment Tag', 'PASS', `Found ${envTag} tag in ECR`);
                } else {
                    this.addResult(
                        'Environment Tag',
                        'WARN',
                        `${envTag} tag not found in ECR (normal for new environments)`,
                    );
                }
            } else {
                this.addResult('ECR Repository', 'FAIL', 'balancer-api repository not found');
            }
        } catch (error) {
            this.addResult('Docker Image URI', 'FAIL', 'Failed to validate ECR repository', error);
        }
    }

    async validateSsmParameters(): Promise<void> {
        try {
            console.log('\n📋 Validating SSM Parameters...');

            const parameterNames = [
                `/v3-backend/${this.config.environment}/compute/currentImageTag`,
                `/v3-backend/${this.config.environment}/compute/apiLogGroupArn`,
                `/v3-backend/${this.config.environment}/compute/workerLogGroupArn`,
                `/v3-backend/${this.config.environment}/compute/schedulerLogGroupArn`,
                `/v3-backend/${this.config.environment}/compute/migrationLogGroupArn`,
            ];

            for (const paramName of parameterNames) {
                try {
                    const response = await this.ssmClient.send(
                        new GetParameterCommand({
                            Name: paramName,
                        }),
                    );

                    if (response.Parameter?.Value) {
                        this.addResult(
                            `SSM Parameter: ${paramName.split('/').pop()}`,
                            'PASS',
                            `Value: ${response.Parameter.Value}`,
                        );
                    } else {
                        this.addResult(
                            `SSM Parameter: ${paramName.split('/').pop()}`,
                            'FAIL',
                            'Parameter exists but has no value',
                        );
                    }
                } catch (error) {
                    this.addResult(
                        `SSM Parameter: ${paramName.split('/').pop()}`,
                        'WARN',
                        'Parameter not found (normal before first deployment)',
                    );
                }
            }
        } catch (error) {
            this.addResult('SSM Parameters', 'FAIL', 'Failed to validate SSM parameters', error);
        }
    }

    async validateEcsServices(): Promise<void> {
        try {
            console.log('\n🚢 Validating ECS Services...');

            const clusterName = `v3-backend-${this.config.environment}-cluster`;
            const serviceNames = [
                `v3-backend-${this.config.environment}-api-service`,
                `v3-backend-${this.config.environment}-worker-service`,
                `v3-backend-${this.config.environment}-scheduler-service`,
            ];

            const response = await this.ecsClient.send(
                new DescribeServicesCommand({
                    cluster: clusterName,
                    services: serviceNames,
                }),
            );

            if (response.services) {
                for (const service of response.services) {
                    const serviceName = service.serviceName || 'unknown';
                    const status = service.status;
                    const runningCount = service.runningCount || 0;
                    const desiredCount = service.desiredCount || 0;

                    if (status === 'ACTIVE' && runningCount >= desiredCount) {
                        this.addResult(
                            `ECS Service: ${serviceName.split('-').pop()}`,
                            'PASS',
                            `${runningCount}/${desiredCount} tasks running`,
                        );
                    } else {
                        this.addResult(
                            `ECS Service: ${serviceName.split('-').pop()}`,
                            'WARN',
                            `Status: ${status}, Tasks: ${runningCount}/${desiredCount}`,
                        );
                    }
                }
            }

            // Check if we found all expected services
            const foundServices = response.services?.length || 0;
            if (foundServices === serviceNames.length) {
                this.addResult('ECS Services Discovery', 'PASS', `Found all ${foundServices} expected services`);
            } else {
                this.addResult(
                    'ECS Services Discovery',
                    'WARN',
                    `Found ${foundServices}/${serviceNames.length} services (normal before first deployment)`,
                );
            }
        } catch (error) {
            this.addResult(
                'ECS Services',
                'WARN',
                'Could not validate ECS services (normal before first deployment)',
                error instanceof Error ? error.message : error,
            );
        }
    }

    async validateCloudFormationStacks(): Promise<void> {
        try {
            console.log('\n☁️ Validating CloudFormation Stacks...');

            const expectedStacks = [
                `v3-backend-${this.config.environment}-networking`,
                `v3-backend-${this.config.environment}-security`,
                `v3-backend-${this.config.environment}-s3`,
                `v3-backend-${this.config.environment}-sqs`,
                `v3-backend-${this.config.environment}-secrets`,
                `v3-backend-${this.config.environment}-database`,
                `v3-backend-${this.config.environment}-compute`,
                `v3-backend-${this.config.environment}-monitoring`,
                `v3-backend-${this.config.environment}-log-forwarder`,
            ];

            for (const stackName of expectedStacks) {
                try {
                    const response = await this.cfnClient.send(
                        new DescribeStacksCommand({
                            StackName: stackName,
                        }),
                    );

                    const stack = response.Stacks?.[0];
                    if (stack) {
                        const status = stack.StackStatus;
                        if (status?.includes('COMPLETE')) {
                            this.addResult(`Stack: ${stackName.split('-').pop()}`, 'PASS', `Status: ${status}`);
                        } else {
                            this.addResult(`Stack: ${stackName.split('-').pop()}`, 'WARN', `Status: ${status}`);
                        }
                    }
                } catch (error) {
                    this.addResult(
                        `Stack: ${stackName.split('-').pop()}`,
                        'WARN',
                        'Stack not found (normal before first deployment)',
                    );
                }
            }
        } catch (error) {
            this.addResult('CloudFormation Stacks', 'FAIL', 'Failed to validate CloudFormation stacks', error);
        }
    }

    async validateNpmScripts(): Promise<void> {
        console.log('\n📦 Validating NPM Scripts...');

        const requiredScripts = [
            'deploy:dev:code-only',
            'deploy:staging:code-only',
            'deploy:prod:code-only',
            'deploy:dev:infra',
            'deploy:staging:infra',
            'deploy:prod:infra',
            'monitor:dev:deployment',
            'monitor:staging:deployment',
            'monitor:prod:deployment',
        ];

        try {
            const packageJson = require('../package.json');
            const scripts = packageJson.scripts || {};

            for (const scriptName of requiredScripts) {
                if (scripts[scriptName]) {
                    this.addResult(`NPM Script: ${scriptName}`, 'PASS', 'Script exists');
                } else {
                    this.addResult(`NPM Script: ${scriptName}`, 'FAIL', 'Script missing from package.json');
                }
            }
        } catch (error) {
            this.addResult('NPM Scripts', 'FAIL', 'Failed to read package.json', error);
        }
    }

    async validateWorkflows(): Promise<void> {
        console.log('\n🔄 Validating GitHub Workflows...');

        const fs = require('fs');
        const path = require('path');

        const workflowFiles = ['deploy-infra.yml', 'deploy-code.yml'];

        for (const filename of workflowFiles) {
            const filePath = path.join(__dirname, '../../.github/workflows', filename);
            try {
                if (fs.existsSync(filePath)) {
                    const content = fs.readFileSync(filePath, 'utf8');

                    // Basic validation
                    if (content.includes('workflow_dispatch') && content.includes('environment')) {
                        this.addResult(`Workflow: ${filename}`, 'PASS', 'File exists and has required triggers');
                    } else {
                        this.addResult(
                            `Workflow: ${filename}`,
                            'WARN',
                            'File exists but may be missing required configuration',
                        );
                    }
                } else {
                    this.addResult(`Workflow: ${filename}`, 'FAIL', 'Workflow file not found');
                }
            } catch (error) {
                this.addResult(`Workflow: ${filename}`, 'FAIL', 'Failed to read workflow file', error);
            }
        }
    }

    async runAllValidations(): Promise<void> {
        console.log(`🔍 Starting validation for environment: ${this.config.environment}\n`);

        await this.validateDockerImageUri();
        await this.validateSsmParameters();
        await this.validateEcsServices();
        await this.validateCloudFormationStacks();
        this.validateNpmScripts();
        this.validateWorkflows();

        this.printSummary();
    }

    private printSummary(): void {
        console.log('\n📊 Validation Summary:');
        console.log('='.repeat(50));

        const passed = this.results.filter((r) => r.status === 'PASS').length;
        const warned = this.results.filter((r) => r.status === 'WARN').length;
        const failed = this.results.filter((r) => r.status === 'FAIL').length;

        console.log(`✅ Passed: ${passed}`);
        console.log(`⚠️  Warnings: ${warned}`);
        console.log(`❌ Failed: ${failed}`);

        if (failed > 0) {
            console.log('\n🔥 Critical Issues Found:');
            this.results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`   • ${r.test}: ${r.message}`));

            console.log('\n💡 Next Steps:');
            console.log('   1. Fix critical issues before deployment');
            console.log('   2. Review warnings for potential improvements');
            console.log('   3. Run validation again after fixes');
        } else if (warned > 0) {
            console.log('\n⚠️  Some warnings detected (normal for new environments)');
            console.log('   Ready for first deployment after infrastructure setup');
        } else {
            console.log('\n🎉 All validations passed! Infrastructure separation is ready.');
        }
    }
}

// CLI interface
if (require.main === module) {
    program
        .name('validate-separation')
        .description('Validate infrastructure and code deployment separation implementation')
        .requiredOption('--environment <env>', 'Target environment (development, staging, production)')
        .option('--region <region>', 'AWS region', 'us-east-1')
        .action(async (options) => {
            try {
                const validator = new SeparationValidator({
                    environment: normalizeEnvironmentName(options.environment),
                    region: options.region,
                });

                await validator.runAllValidations();
                process.exit(0);
            } catch (error) {
                console.error('Validation failed:', error);
                process.exit(1);
            }
        });

    program.parse();
}
