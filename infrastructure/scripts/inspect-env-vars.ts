#!/usr/bin/env ts-node

import { Command } from 'commander';
import {
    ECSClient,
    DescribeClustersCommand,
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    ListClustersCommand,
    ListServicesCommand,
    ListTaskDefinitionsCommand,
} from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import * as fs from 'fs';
import * as path from 'path';

interface EnvVarInfo {
    name: string;
    value: string;
    isSensitive: boolean;
    source: 'environment' | 'secrets';
}

interface ExpectedEnvVar {
    name: string;
    required: boolean;
    pattern?: RegExp;
    description?: string;
    dependsOn?: string[];
    validationFn?: (value: string) => boolean;
}

interface ValidationResult {
    missing: string[];
    invalid: { name: string; reason: string }[];
    unexpected: string[];
    warnings: string[];
}

interface IssueReport {
    severity: 'critical' | 'warning' | 'info';
    category: 'missing_env_var' | 'service_down' | 'config_drift' | 'security' | 'performance' | 'validation';
    description: string;
    service: string;
    recommendation: string;
    quickFix?: string;
}

interface ServiceEnvVars {
    serviceName: string;
    clusterName: string;
    taskDefinitionArn: string;
    envVars: EnvVarInfo[];
    status: 'running' | 'stopped' | 'pending' | 'unknown' | 'task-definition';
    desiredCount: number;
    runningCount: number;
    taskDefinitionRevision: number;
    lastUpdated?: Date;
    validation?: ValidationResult;
    issues?: IssueReport[];
}

interface EnvironmentInspectionResult {
    environment: string;
    region: string;
    timestamp: string;
    services: ServiceEnvVars[];
    summary: {
        totalServices: number;
        totalEnvVars: number;
        sensitiveVars: number;
        criticalIssues: number;
        warnings: number;
        healthyServices: number;
    };
    globalIssues: IssueReport[];
}

class EnvVarInspector {
    private ecsClient: ECSClient;
    private logsClient: CloudWatchLogsClient;
    private region: string;
    private environment: string;
    private sensitivePatterns: string[] = [
        'PASSWORD',
        'SECRET',
        'TOKEN',
        'KEY',
        'AUTH',
        'CREDENTIAL',
        'PRIVATE',
        'SENSITIVE',
        'DATABASE_URL',
        'REDIS_URL',
        'JWT',
        'API_KEY',
        'ACCESS_KEY',
        'SESSION',
    ];

    // Expected environment variables by service type
    private expectedEnvVars: Record<string, ExpectedEnvVar[]> = {
        api: [
            { name: 'CONFIG_SECRET', required: true, description: 'Main configuration secret' },
            {
                name: 'DATABASE_URL',
                required: true,
                pattern: /^postgres:\/\//,
                description: 'PostgreSQL connection string',
            },
            { name: 'REDIS_URL', required: true, pattern: /^redis:\/\//, description: 'Redis connection string' },
            { name: 'JWT_SECRET', required: true, description: 'JWT signing secret' },
            { name: 'PORT', required: false, pattern: /^\d+$/, description: 'API port number' },
            { name: 'NODE_ENV', required: true, description: 'Node environment' },
        ],
        worker: [
            { name: 'CONFIG_SECRET', required: true, description: 'Main configuration secret' },
            {
                name: 'DATABASE_URL',
                required: true,
                pattern: /^postgres:\/\//,
                description: 'PostgreSQL connection string',
            },
            { name: 'REDIS_URL', required: true, pattern: /^redis:\/\//, description: 'Redis connection string' },
            { name: 'NODE_ENV', required: true, description: 'Node environment' },
        ],
        scheduler: [
            { name: 'CONFIG_SECRET', required: true, description: 'Main configuration secret' },
            {
                name: 'DATABASE_URL',
                required: true,
                pattern: /^postgres:\/\//,
                description: 'PostgreSQL connection string',
            },
            { name: 'REDIS_URL', required: true, pattern: /^redis:\/\//, description: 'Redis connection string' },
            { name: 'NODE_ENV', required: true, description: 'Node environment' },
        ],
    };

    constructor(region: string, environment: string) {
        this.ecsClient = new ECSClient({ region });
        this.logsClient = new CloudWatchLogsClient({ region });
        this.region = region;
        this.environment = environment;
    }

    private isSensitiveVar(name: string): boolean {
        const upperName = name.toUpperCase();
        return this.sensitivePatterns.some((pattern) => upperName.includes(pattern));
    }

    private maskValue(value: string, isSensitive: boolean, maskSecrets: boolean): string {
        if (!maskSecrets || !isSensitive) {
            return value;
        }

        if (value.length <= 8) {
            return '*'.repeat(value.length);
        }

        return `${value.substring(0, 3)}${'*'.repeat(Math.min(value.length - 6, 10))}${value.substring(
            value.length - 3,
        )}`;
    }

    private getServiceType(serviceName: string): string {
        if (serviceName.includes('api')) return 'api';
        if (serviceName.includes('worker')) return 'worker';
        if (serviceName.includes('scheduler')) return 'scheduler';
        return 'unknown';
    }

    private validateEnvironmentVariables(envVars: EnvVarInfo[], serviceType: string): ValidationResult {
        const expected = this.expectedEnvVars[serviceType] || [];
        const envVarNames = envVars.map((e) => e.name);

        const missing = expected.filter((e) => e.required && !envVarNames.includes(e.name)).map((e) => e.name);

        const invalid: { name: string; reason: string }[] = [];
        const warnings: string[] = [];

        // Validate existing environment variables
        for (const envVar of envVars) {
            const expectedVar = expected.find((e) => e.name === envVar.name);
            if (expectedVar) {
                // Check pattern validation
                if (expectedVar.pattern && !expectedVar.pattern.test(envVar.value)) {
                    invalid.push({
                        name: envVar.name,
                        reason: `Value doesn't match expected pattern: ${expectedVar.pattern.source}`,
                    });
                }

                // Check custom validation function
                if (expectedVar.validationFn && !expectedVar.validationFn(envVar.value)) {
                    invalid.push({
                        name: envVar.name,
                        reason: 'Custom validation failed',
                    });
                }

                // Check for empty values on required vars
                if (expectedVar.required && !envVar.value.trim()) {
                    invalid.push({
                        name: envVar.name,
                        reason: 'Required environment variable is empty',
                    });
                }
            }

            // Security checks
            if (envVar.isSensitive && envVar.value.length < 8) {
                warnings.push(`${envVar.name}: Sensitive value appears too short (possible security issue)`);
            }

            if (envVar.name.includes('URL') && envVar.value.includes('localhost')) {
                warnings.push(
                    `${envVar.name}: Contains localhost (check if this is intentional for ${this.environment})`,
                );
            }
        }

        const unexpected = envVarNames.filter(
            (name) => !expected.some((e) => e.name === name) && !name.startsWith('AWS_'), // Ignore AWS default vars
        );

        return { missing, invalid, unexpected, warnings };
    }

    private generateIssues(service: ServiceEnvVars): IssueReport[] {
        const issues: IssueReport[] = [];

        // Service health issues
        if (service.desiredCount > 0 && service.runningCount === 0) {
            issues.push({
                severity: 'critical',
                category: 'service_down',
                description: `Service ${service.serviceName} is not running (0/${service.desiredCount})`,
                service: service.serviceName,
                recommendation: 'Check service logs and task definition for errors',
                quickFix: `aws ecs describe-services --cluster ${service.clusterName} --services ${service.serviceName}`,
            });
        }

        if (service.desiredCount > 0 && service.runningCount < service.desiredCount) {
            issues.push({
                severity: 'warning',
                category: 'performance',
                description: `Service ${service.serviceName} is running below desired capacity (${service.runningCount}/${service.desiredCount})`,
                service: service.serviceName,
                recommendation: 'Check for resource constraints or deployment issues',
            });
        }

        // Environment variable issues
        if (service.validation) {
            service.validation.missing.forEach((varName) => {
                issues.push({
                    severity: 'critical',
                    category: 'missing_env_var',
                    description: `Missing required environment variable: ${varName}`,
                    service: service.serviceName,
                    recommendation: `Add ${varName} to the task definition`,
                    quickFix: `Check task definition ${service.taskDefinitionArn.split('/').pop()}`,
                });
            });

            service.validation.invalid.forEach(({ name, reason }) => {
                issues.push({
                    severity: 'critical',
                    category: 'validation',
                    description: `Invalid environment variable ${name}: ${reason}`,
                    service: service.serviceName,
                    recommendation: `Fix the value of ${name} in the task definition`,
                });
            });

            service.validation.unexpected.forEach((varName) => {
                issues.push({
                    severity: 'info',
                    category: 'config_drift',
                    description: `Unexpected environment variable: ${varName}`,
                    service: service.serviceName,
                    recommendation: `Verify if ${varName} is needed or remove it to reduce configuration drift`,
                });
            });

            service.validation.warnings.forEach((warning) => {
                issues.push({
                    severity: 'warning',
                    category: 'security',
                    description: warning,
                    service: service.serviceName,
                    recommendation: 'Review the flagged configuration for security concerns',
                });
            });
        }

        return issues;
    }

    public generateHealthReport(result: EnvironmentInspectionResult): string {
        const criticalIssues = result.globalIssues.filter((i) => i.severity === 'critical');
        const warnings = result.globalIssues.filter((i) => i.severity === 'warning');

        let report = `\n🏥 HEALTH REPORT for ${result.environment.toUpperCase()}\n`;
        report += `═══════════════════════════════════════════════════════════════\n`;

        if (criticalIssues.length === 0 && warnings.length === 0) {
            report += `🎉 ALL SYSTEMS HEALTHY! No issues detected.\n`;
        } else {
            report += `📊 Issues Summary:\n`;
            report += `   🔴 Critical: ${criticalIssues.length}\n`;
            report += `   🟡 Warnings: ${warnings.length}\n`;
            report += `   🟢 Healthy Services: ${result.summary.healthyServices}/${result.summary.totalServices}\n\n`;

            if (criticalIssues.length > 0) {
                report += `🚨 CRITICAL ISSUES (require immediate attention):\n`;
                criticalIssues.forEach((issue, index) => {
                    report += `   ${index + 1}. ${issue.service}: ${issue.description}\n`;
                    report += `      → ${issue.recommendation}\n`;
                    if (issue.quickFix) {
                        report += `      🔧 Quick Fix: ${issue.quickFix}\n`;
                    }
                    report += `\n`;
                });
            }
        }

        return report;
    }

    private async getEnvironmentClusters(): Promise<string[]> {
        try {
            const listClustersResponse = await this.ecsClient.send(new ListClustersCommand({}));
            const allClusters = listClustersResponse.clusterArns || [];

            // Filter clusters by environment naming convention
            const envClusters = allClusters.filter(
                (arn) => arn.includes(`-${this.environment}-`) || arn.includes(`v3-backend-${this.environment}`),
            );

            return envClusters;
        } catch (error) {
            console.error('Error fetching clusters:', error);
            return [];
        }
    }

    /**
     * ✅ NEW: Get task definitions directly by naming convention
     * This works even when services aren't running!
     */
    private async getEnvironmentTaskDefinitions(): Promise<string[]> {
        try {
            const listTaskDefsResponse = await this.ecsClient.send(
                new ListTaskDefinitionsCommand({
                    status: 'ACTIVE',
                    maxResults: 100,
                }),
            );

            const allTaskDefs = listTaskDefsResponse.taskDefinitionArns || [];
            console.log(`🔍 Found ${allTaskDefs.length} total task definitions in account`);

            if (allTaskDefs.length > 0) {
                console.log(`📋 All task definitions:`);
                allTaskDefs.forEach((arn) => {
                    const taskDefName = arn.split('/').pop()?.split(':')[0] || '';
                    console.log(`   - ${taskDefName}`);
                });
            }

            // Filter by environment naming convention
            const envTaskDefs = allTaskDefs.filter((arn) => {
                const taskDefName = arn.split('/').pop()?.split(':')[0] || '';
                const matches =
                    taskDefName.includes(`v3-backend-${this.environment}-`) ||
                    taskDefName.includes(`-${this.environment}-`) ||
                    taskDefName.includes(`${this.environment}`); // More lenient matching

                if (matches) {
                    console.log(`✅ Task definition matches environment filter: ${taskDefName}`);
                }

                return matches;
            });

            console.log(`🎯 Found ${envTaskDefs.length} task definitions for environment: ${this.environment}\n`);
            return envTaskDefs;
        } catch (error) {
            console.error('Error fetching task definitions:', error);
            return [];
        }
    }

    private async getServicesInCluster(clusterArn: string): Promise<any[]> {
        try {
            const listServicesResponse = await this.ecsClient.send(new ListServicesCommand({ cluster: clusterArn }));

            if (!listServicesResponse.serviceArns?.length) {
                return [];
            }

            const describeServicesResponse = await this.ecsClient.send(
                new DescribeServicesCommand({
                    cluster: clusterArn,
                    services: listServicesResponse.serviceArns,
                }),
            );

            return describeServicesResponse.services || [];
        } catch (error) {
            console.error(`Error fetching services for cluster ${clusterArn}:`, error);
            return [];
        }
    }

    private async getTaskDefinitionEnvVars(taskDefinitionArn: string): Promise<EnvVarInfo[]> {
        try {
            const taskDefResponse = await this.ecsClient.send(
                new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }),
            );

            const containerDefinitions = taskDefResponse.taskDefinition?.containerDefinitions || [];
            const envVars: EnvVarInfo[] = [];

            for (const container of containerDefinitions) {
                // Regular environment variables
                if (container.environment) {
                    for (const envVar of container.environment) {
                        if (envVar.name && envVar.value) {
                            envVars.push({
                                name: envVar.name,
                                value: envVar.value,
                                isSensitive: this.isSensitiveVar(envVar.name),
                                source: 'environment',
                            });
                        }
                    }
                }

                // Secrets from AWS Secrets Manager or Parameter Store
                if (container.secrets) {
                    for (const secret of container.secrets) {
                        if (secret.name && secret.valueFrom) {
                            envVars.push({
                                name: secret.name,
                                value: secret.valueFrom,
                                isSensitive: true,
                                source: 'secrets',
                            });
                        }
                    }
                }
            }

            return envVars;
        } catch (error) {
            console.error(`Error fetching task definition ${taskDefinitionArn}:`, error);
            return [];
        }
    }

    async inspect(): Promise<EnvironmentInspectionResult> {
        console.log(`🔍 Inspecting environment variables for ${this.environment} environment...\n`);

        const clusters = await this.getEnvironmentClusters();
        const services: ServiceEnvVars[] = [];

        for (const clusterArn of clusters) {
            const clusterName = clusterArn.split('/').pop() || clusterArn;
            const clusterServices = await this.getServicesInCluster(clusterArn);

            for (const service of clusterServices) {
                const serviceName = service.serviceName || 'unknown';
                const taskDefinitionArn = service.taskDefinition;
                const status = service.status?.toLowerCase() || 'unknown';
                const desiredCount = service.desiredCount || 0;
                const runningCount = service.runningCount || 0;

                const envVars = await this.getTaskDefinitionEnvVars(taskDefinitionArn);

                const serviceType = this.getServiceType(serviceName);
                const validation = this.validateEnvironmentVariables(envVars, serviceType);
                const issues = this.generateIssues({
                    serviceName,
                    clusterName,
                    taskDefinitionArn,
                    envVars,
                    status: status as any,
                    desiredCount,
                    runningCount,
                    taskDefinitionRevision: 0,
                    validation,
                });

                services.push({
                    serviceName,
                    clusterName,
                    taskDefinitionArn,
                    envVars,
                    status: status as any,
                    desiredCount,
                    runningCount,
                    taskDefinitionRevision: 0,
                    validation,
                    issues,
                });
            }
        }

        // ✅ NEW: If no services found, look for task definitions directly
        if (services.length === 0) {
            console.log(`⚠️  No running services found. Looking for task definitions directly...\n`);

            const taskDefinitions = await this.getEnvironmentTaskDefinitions();

            for (const taskDefArn of taskDefinitions) {
                const taskDefName = taskDefArn.split('/').pop()?.split(':')[0] || 'unknown';
                const envVars = await this.getTaskDefinitionEnvVars(taskDefArn);

                const serviceType = this.getServiceType(taskDefName);
                const validation = this.validateEnvironmentVariables(envVars, serviceType);
                const issues = this.generateIssues({
                    serviceName: `${taskDefName} (task definition only)`,
                    clusterName: 'no-cluster',
                    taskDefinitionArn: taskDefArn,
                    envVars,
                    status: 'task-definition' as any,
                    desiredCount: 0,
                    runningCount: 0,
                    taskDefinitionRevision: 0,
                    validation,
                });

                services.push({
                    serviceName: `${taskDefName} (task definition only)`,
                    clusterName: 'no-cluster',
                    taskDefinitionArn: taskDefArn,
                    envVars,
                    status: 'task-definition' as any,
                    desiredCount: 0,
                    runningCount: 0,
                    taskDefinitionRevision: 0,
                    validation,
                    issues,
                });
            }
        }

        // Calculate summary
        const totalServices = services.length;
        const totalEnvVars = services.reduce((sum, service) => sum + service.envVars.length, 0);
        const sensitiveVars = services.reduce(
            (sum, service) => sum + service.envVars.filter((v) => v.isSensitive).length,
            0,
        );

        const criticalIssues = services.reduce(
            (sum, service) => sum + (service.issues?.filter((i) => i.severity === 'critical').length || 0),
            0,
        );
        const warnings = services.reduce(
            (sum, service) => sum + (service.issues?.filter((i) => i.severity === 'warning').length || 0),
            0,
        );
        const healthyServices = services.reduce(
            (sum, service) => sum + (service.status !== 'task-definition' && service.status !== 'stopped' ? 1 : 0),
            0,
        );

        return {
            environment: this.environment,
            region: this.region,
            timestamp: new Date().toISOString(),
            services,
            summary: {
                totalServices,
                totalEnvVars,
                sensitiveVars,
                criticalIssues,
                warnings,
                healthyServices,
            },
            globalIssues: services.reduce((sum, service) => sum.concat(service.issues || []), [] as IssueReport[]),
        };
    }

    filterEnvVars(result: EnvironmentInspectionResult, patterns: string[]): EnvironmentInspectionResult {
        if (!patterns.length) return result;

        const filteredServices = result.services.map((service) => ({
            ...service,
            envVars: service.envVars.filter((envVar) =>
                patterns.some((pattern) => {
                    // Support wildcards with simple regex
                    const regex = new RegExp(pattern.replace(/\*/g, '.*'), 'i');
                    return regex.test(envVar.name);
                }),
            ),
        }));

        return {
            ...result,
            services: filteredServices,
        };
    }
}

class OutputFormatter {
    static formatTable(result: EnvironmentInspectionResult, maskSecrets: boolean = true): string {
        let output = '';

        // Header with enhanced summary
        output += `\n🔍 Environment Variables - ${result.environment.toUpperCase()} (${result.region})\n`;
        output += `📊 Summary: ${result.summary.totalServices} services, ${result.summary.totalEnvVars} variables (${result.summary.sensitiveVars} sensitive)\n`;
        output += `🎯 Health: ${result.summary.healthyServices} healthy, ${result.summary.criticalIssues} critical issues, ${result.summary.warnings} warnings\n\n`;

        // Critical issues summary
        if (result.summary.criticalIssues > 0) {
            output += `🚨 CRITICAL ISSUES DETECTED:\n`;
            const criticalIssues = result.globalIssues.filter((i) => i.severity === 'critical');
            criticalIssues.forEach((issue) => {
                output += `   ❌ ${issue.service}: ${issue.description}\n`;
                output += `      💡 ${issue.recommendation}\n`;
                if (issue.quickFix) {
                    output += `      🔧 ${issue.quickFix}\n`;
                }
            });
            output += '\n';
        }

        for (const service of result.services) {
            // Service header with health status
            const healthIcon = service.issues?.some((i) => i.severity === 'critical')
                ? '🔴'
                : service.issues?.some((i) => i.severity === 'warning')
                ? '🟡'
                : '🟢';

            output += `📦 ${healthIcon} Service: ${service.serviceName}\n`;
            output += `   Cluster: ${service.clusterName}\n`;
            output += `   Status: ${service.status} (${service.runningCount}/${service.desiredCount})\n`;
            output += `   Task Definition: ${service.taskDefinitionArn.split('/').pop()}\n`;

            // Show validation summary
            if (service.validation) {
                const { missing, invalid, unexpected, warnings } = service.validation;
                if (missing.length > 0 || invalid.length > 0 || unexpected.length > 0 || warnings.length > 0) {
                    output += `   Validation: ${missing.length} missing, ${invalid.length} invalid, ${unexpected.length} unexpected, ${warnings.length} warnings\n`;
                }
            }
            output += '\n';

            // Service-specific issues
            if (service.issues && service.issues.length > 0) {
                output += `   🔍 Issues:\n`;
                service.issues.forEach((issue) => {
                    const icon = issue.severity === 'critical' ? '❌' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
                    output += `      ${icon} ${issue.description}\n`;
                    output += `         💡 ${issue.recommendation}\n`;
                });
                output += '\n';
            }

            if (service.envVars.length === 0) {
                output += '   No environment variables configured\n\n';
                continue;
            }

            // Environment variables table
            const tableData = [
                ['Variable', 'Value', 'Source', 'Status'],
                ...service.envVars.map((envVar) => {
                    const isMissing = service.validation?.missing.includes(envVar.name);
                    const isInvalid = service.validation?.invalid.some((i) => i.name === envVar.name);
                    const isUnexpected = service.validation?.unexpected.includes(envVar.name);

                    let status = envVar.isSensitive ? '🔒' : '✅';
                    if (isMissing) status = '❌ Missing';
                    else if (isInvalid) status = '❌ Invalid';
                    else if (isUnexpected) status = '❓ Unexpected';

                    return [
                        envVar.name,
                        this.maskValue(envVar.value, envVar.isSensitive, maskSecrets),
                        envVar.source,
                        status,
                    ];
                }),
            ];

            output += this.formatSimpleTable(tableData, '   Environment Variables');

            output += '\n';
        }

        return output;
    }

    private static formatSimpleTable(data: string[][], title: string): string {
        if (data.length === 0) return '';

        // Calculate column widths
        const colWidths = data[0].map((_, colIndex) => Math.max(...data.map((row) => (row[colIndex] || '').length)));

        // Set minimum column widths
        colWidths[0] = Math.max(colWidths[0], 20); // Variable name
        colWidths[1] = Math.max(colWidths[1], 30); // Value
        colWidths[2] = Math.max(colWidths[2], 10); // Source
        colWidths[3] = Math.max(colWidths[3], 9); // Sensitive

        let output = `\n   ${title}\n`;

        // Header separator
        output += '   ' + colWidths.map((width) => '-'.repeat(width)).join('-+-') + '\n';

        // Format each row
        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            const formattedRow = row
                .map((cell, colIndex) => {
                    const cellStr = (cell || '').substring(0, colWidths[colIndex]);
                    return cellStr.padEnd(colWidths[colIndex]);
                })
                .join(' | ');

            output += `   ${formattedRow}\n`;

            // Add separator after header
            if (i === 0) {
                output += '   ' + colWidths.map((width) => '-'.repeat(width)).join('-+-') + '\n';
            }
        }

        return output;
    }

    static formatJSON(result: EnvironmentInspectionResult, maskSecrets: boolean = true): string {
        const maskedResult = {
            ...result,
            services: result.services.map((service) => ({
                ...service,
                envVars: service.envVars.map((envVar) => ({
                    ...envVar,
                    value: this.maskValue(envVar.value, envVar.isSensitive, maskSecrets),
                })),
            })),
        };

        return JSON.stringify(maskedResult, null, 2);
    }

    static formatCompact(result: EnvironmentInspectionResult, maskSecrets: boolean = true): string {
        let output = '';

        output += `Environment: ${result.environment} | Region: ${result.region}\n`;
        output += `Services: ${result.summary.totalServices} | Variables: ${result.summary.totalEnvVars} | Sensitive: ${result.summary.sensitiveVars}\n`;
        output += `Health: ${result.summary.healthyServices} healthy, ${result.summary.criticalIssues} critical, ${result.summary.warnings} warnings\n\n`;

        for (const service of result.services) {
            const healthIcon = service.issues?.some((i) => i.severity === 'critical')
                ? '🔴'
                : service.issues?.some((i) => i.severity === 'warning')
                ? '🟡'
                : '🟢';

            output += `${healthIcon} ${service.serviceName} (${service.status}):\n`;

            // Show critical issues first
            if (service.issues) {
                const criticalIssues = service.issues.filter((i) => i.severity === 'critical');
                criticalIssues.forEach((issue) => {
                    output += `  ❌ ${issue.description}\n`;
                });
            }

            for (const envVar of service.envVars) {
                const maskedValue = this.maskValue(envVar.value, envVar.isSensitive, maskSecrets);
                const sensitiveFlag = envVar.isSensitive ? ' 🔒' : '';
                output += `  ${envVar.name}=${maskedValue}${sensitiveFlag}\n`;
            }

            output += '\n';
        }

        return output;
    }

    private static maskValue(value: string, isSensitive: boolean, maskSecrets: boolean): string {
        if (!maskSecrets || !isSensitive) {
            return value;
        }

        if (value.length <= 8) {
            return '*'.repeat(value.length);
        }

        return `${value.substring(0, 3)}${'*'.repeat(Math.min(value.length - 6, 10))}${value.substring(
            value.length - 3,
        )}`;
    }
}

// CLI setup
const program = new Command();

program
    .name('inspect-env-vars')
    .description('Inspect environment variables in ECS services')
    .option('-e, --env <environment>', 'Environment to inspect', 'development')
    .option('-r, --region <region>', 'AWS region', 'us-east-1')
    .option('-f, --filter <patterns>', 'Filter environment variables (comma-separated, supports wildcards)', '')
    .option('-j, --json', 'Output JSON format')
    .option('-c, --compact', 'Output compact format')
    .option('--no-mask', 'Do not mask sensitive values (use with caution)')
    .option('-q, --quiet', 'Suppress progress messages')
    .option('--validate', 'Enable validation and issue detection')
    .option('--issues-only', 'Only show services with issues')
    .option('--health-check', 'Perform comprehensive health checks');

program.parse();

const options = program.opts();

async function main() {
    try {
        const inspector = new EnvVarInspector(options.region, options.env);
        let result = await inspector.inspect();

        // Apply filters if specified
        if (options.filter) {
            const patterns = options.filter
                .split(',')
                .map((p: string) => p.trim())
                .filter((p: string) => p);
            result = inspector.filterEnvVars(result, patterns);
        }

        // Filter to only show services with issues if requested
        if (options.issuesOnly) {
            result.services = result.services.filter((service) => service.issues && service.issues.length > 0);
        }

        // Output results
        if (options.healthCheck) {
            console.log(inspector.generateHealthReport(result));
        } else if (options.json) {
            console.log(OutputFormatter.formatJSON(result, options.mask));
        } else if (options.compact) {
            console.log(OutputFormatter.formatCompact(result, options.mask));
        } else {
            console.log(OutputFormatter.formatTable(result, options.mask));
        }

        // Exit with appropriate code based on health status
        const hasServices = result.services.length > 0;
        const hasEnvVars = result.summary.totalEnvVars > 0;
        const hasRunningServices = result.services.some((s) => s.status !== 'task-definition');
        const hasCriticalIssues = result.summary.criticalIssues > 0;
        const hasWarnings = result.summary.warnings > 0;

        if (!hasServices) {
            console.error(`⚠️  No services or task definitions found for environment: ${options.env}`);
            process.exit(1);
        }

        if (!hasEnvVars) {
            console.warn(`⚠️  No environment variables found in any task definition`);
            process.exit(2);
        }

        if (hasCriticalIssues) {
            console.error(`🚨 Critical issues detected in environment: ${options.env}`);
            process.exit(3);
        }

        if (hasWarnings) {
            console.warn(`⚠️  Warnings detected in environment: ${options.env}`);
            process.exit(4);
        }

        if (!hasRunningServices && hasServices) {
            console.log(`ℹ️  Found task definitions but no running services for environment: ${options.env}`);
            process.exit(5);
        }

        console.log(`✅ Environment ${options.env} is healthy!`);
        process.exit(0);
    } catch (error) {
        console.error(
            '❌ Failed to inspect environment variables:',
            error instanceof Error ? error.message : 'Unknown error',
        );
        process.exit(3);
    }
}

if (require.main === module) {
    main();
}

export { EnvVarInspector, OutputFormatter };
