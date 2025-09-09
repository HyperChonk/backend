#!/usr/bin/env ts-node

import {
    ECSClient,
    DescribeServicesCommand,
    ListTasksCommand,
    DescribeTasksCommand,
    DescribeServicesCommandOutput,
    ListTasksCommandOutput,
    DescribeTasksCommandOutput,
} from '@aws-sdk/client-ecs';
import { program } from 'commander';
import { normalizeEnvironmentName } from '../config/environments/shared';

interface DeploymentDiagnosis {
    environment: string;
    services: {
        api: ServiceDiagnosis;
        worker: ServiceDiagnosis;
        scheduler: ServiceDiagnosis;
    };
}

interface ServiceDiagnosis {
    name: string;
    status: 'healthy' | 'degraded' | 'failed';
    runningTasks: number;
    desiredTasks: number;
    deployments: DeploymentInfo[];
    recentTasks: TaskInfo[];
    error?: string;
}

interface DeploymentInfo {
    status: string;
    runningCount: number;
    desiredCount: number;
    createdAt: Date;
    updatedAt: Date;
}

interface TaskInfo {
    taskArn: string;
    lastStatus: string;
    healthStatus: string;
    createdAt: Date;
    startedAt?: Date;
    stoppedAt?: Date;
    stoppedReason?: string;
}

async function diagnoseDeployment(environment: string): Promise<DeploymentDiagnosis> {
    const normalizedEnvironment = normalizeEnvironmentName(environment);
    const envPrefix = `v3-backend-${normalizedEnvironment}`;

    const ecsClient = new ECSClient({
        region: 'us-east-1',
        maxAttempts: 3,
    });
    const cluster = `${envPrefix}-cluster`;

    // Diagnose services with individual error handling
    const services = {
        api: await diagnoseService(ecsClient, cluster, `${envPrefix}-api-service`),
        worker: await diagnoseService(ecsClient, cluster, `${envPrefix}-worker-service`),
        scheduler: await diagnoseService(ecsClient, cluster, `${envPrefix}-scheduler-service`),
    };

    return {
        environment,
        services,
    };
}

async function diagnoseService(ecsClient: ECSClient, cluster: string, serviceName: string): Promise<ServiceDiagnosis> {
    try {
        console.error(`[DEBUG] Diagnosing service: ${serviceName} in cluster: ${cluster}`);

        // Get service details with timeout
        const serviceResponse = (await Promise.race([
            ecsClient.send(
                new DescribeServicesCommand({
                    cluster,
                    services: [serviceName],
                }),
            ),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Service describe timeout')), 20000)),
        ])) as DescribeServicesCommandOutput;

        const service = serviceResponse.services?.[0];
        if (!service) {
            console.error(`[DEBUG] Service not found: ${serviceName}`);
            return {
                name: serviceName,
                status: 'failed',
                runningTasks: 0,
                desiredTasks: 0,
                deployments: [],
                recentTasks: [],
                error: 'Service not found',
            };
        }

        console.error(
            `[DEBUG] Service found: ${serviceName}, running: ${service.runningCount}, desired: ${service.desiredCount}`,
        );

        // Get recent tasks with timeout and error handling
        let taskResponse: ListTasksCommandOutput | undefined;
        let taskDetails: DescribeTasksCommandOutput = {
            tasks: [],
            $metadata: {},
        };

        try {
            taskResponse = (await Promise.race([
                ecsClient.send(
                    new ListTasksCommand({
                        cluster,
                        serviceName,
                        maxResults: 10,
                    }),
                ),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Task list timeout')), 15000)),
            ])) as ListTasksCommandOutput;

            if (taskResponse.taskArns?.length) {
                taskDetails = (await Promise.race([
                    ecsClient.send(
                        new DescribeTasksCommand({
                            cluster,
                            tasks: taskResponse.taskArns,
                        }),
                    ),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error('Task describe timeout')), 15000),
                    ),
                ])) as DescribeTasksCommandOutput;
            }
        } catch (taskError: any) {
            console.error(
                `[DEBUG] Error getting tasks for ${serviceName}:`,
                taskError?.message || 'Unknown task error',
            );
            // Continue without task details
        }

        // Process deployments safely
        const deployments: DeploymentInfo[] =
            service.deployments?.map((dep: any) => ({
                status: dep.status || 'UNKNOWN',
                runningCount: dep.runningCount || 0,
                desiredCount: dep.desiredCount || 0,
                createdAt: dep.createdAt || new Date(),
                updatedAt: dep.updatedAt || new Date(),
            })) || [];

        // Process tasks safely
        const recentTasks: TaskInfo[] =
            taskDetails.tasks?.map((task: any) => ({
                taskArn: task.taskArn || '',
                lastStatus: task.lastStatus || 'UNKNOWN',
                healthStatus: task.healthStatus || 'UNKNOWN',
                createdAt: task.createdAt || new Date(),
                startedAt: task.startedAt,
                stoppedAt: task.stoppedAt,
                stoppedReason: task.stoppedReason,
            })) || [];

        // Determine status
        const runningTasks = service.runningCount || 0;
        const desiredTasks = service.desiredCount || 0;
        let status: 'healthy' | 'degraded' | 'failed' = 'healthy';

        if (runningTasks === 0) {
            status = 'failed';
        } else if (runningTasks < desiredTasks) {
            status = 'degraded';
        }

        console.error(`[DEBUG] Service ${serviceName} status: ${status}`);

        return {
            name: serviceName,
            status,
            runningTasks,
            desiredTasks,
            deployments,
            recentTasks,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[DEBUG] Error diagnosing service ${serviceName}:`, errorMessage);

        return {
            name: serviceName,
            status: 'failed',
            runningTasks: 0,
            desiredTasks: 0,
            deployments: [],
            recentTasks: [],
            error: errorMessage,
        };
    }
}

function formatDiagnosis(diagnosis: DeploymentDiagnosis, quiet: boolean = false): void {
    if (!quiet) {
        console.log(`\n🔍 Deployment Diagnosis for ${diagnosis.environment}`);
        console.log('='.repeat(50));
    }

    if (!quiet) {
        for (const [serviceType, service] of Object.entries(diagnosis.services)) {
            const statusIcon = service.status === 'healthy' ? '✅' : service.status === 'degraded' ? '⚠️' : '❌';

            console.log(`\n${statusIcon} ${serviceType.toUpperCase()} SERVICE: ${service.name}`);
            console.log(`   Status: ${service.status.toUpperCase()}`);
            console.log(`   Tasks: ${service.runningTasks}/${service.desiredTasks} running`);

            if (service.error) {
                console.log(`   Error: ${service.error}`);
            }

            if (service.deployments.length > 0) {
                console.log(`   Deployments:`);
                service.deployments.forEach((dep, idx) => {
                    const age = Math.round((Date.now() - dep.createdAt.getTime()) / 1000 / 60);
                    console.log(
                        `     ${idx + 1}. ${dep.status} - ${dep.runningCount}/${dep.desiredCount} (${age}m ago)`,
                    );
                });
            }

            if (service.recentTasks.length > 0) {
                console.log(`   Recent Tasks:`);
                service.recentTasks.slice(0, 3).forEach((task) => {
                    const taskId = task.taskArn.split('/').pop()?.substring(0, 8) || 'unknown';
                    const age = Math.round((Date.now() - task.createdAt.getTime()) / 1000 / 60);
                    let status = `${task.lastStatus}`;

                    if (task.stoppedReason) {
                        status += ` (${task.stoppedReason})`;
                    }

                    console.log(`     • ${taskId}: ${status} (${age}m ago)`);
                });
            }
        }
    }

    // Summary
    const healthyCount = Object.values(diagnosis.services).filter((s) => s.status === 'healthy').length;
    const degradedCount = Object.values(diagnosis.services).filter((s) => s.status === 'degraded').length;
    const failedCount = Object.values(diagnosis.services).filter((s) => s.status === 'failed').length;

    if (!quiet) {
        console.log('\n📋 Summary:');
        console.log(`   Healthy: ${healthyCount}, Degraded: ${degradedCount}, Failed: ${failedCount}`);

        if (degradedCount > 0 || failedCount > 0) {
            console.log('\n💡 Recommendations:');
            console.log('   • Check CloudWatch logs for failed tasks');
            console.log('   • Verify database connectivity and secrets');
            console.log('   • Check ECS task definitions for configuration issues');
            console.log('   • Consider rolling back if endpoints are not working');
        }
    }

    // Always output machine-readable summary for scripts
    console.log(`🤖 SUMMARY: Healthy: ${healthyCount}, Degraded: ${degradedCount}, Failed: ${failedCount}`);
}

// CLI interface
program
    .name('deployment-diagnosis')
    .description('Diagnose deployment issues for ECS services')
    .requiredOption('--environment <env>', 'Environment to diagnose (development, staging, production)')
    .option('--quiet', 'Output only summary information')
    .option('--ignore-errors', 'Continue execution even if individual services fail to diagnose')
    .action(async (options) => {
        try {
            console.error(`[DEBUG] Starting diagnosis for environment: ${options.environment}`);

            const diagnosis = await diagnoseDeployment(options.environment);
            formatDiagnosis(diagnosis, options.quiet);

            // Only exit with error if ALL services failed AND ignore-errors is not set
            if (!options.ignoreErrors) {
                const allServicesFailed = Object.values(diagnosis.services).every((s) => s.status === 'failed');
                const hasErrors = Object.values(diagnosis.services).some((s) => s.error);

                if (allServicesFailed && hasErrors) {
                    console.error('[DEBUG] All services failed with errors, exiting with code 1');
                    process.exit(1);
                }
            }

            console.error('[DEBUG] Diagnosis completed successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            const errorStack = error instanceof Error ? error.stack : '';

            console.error('❌ Diagnosis failed:', errorMessage);
            console.error('[DEBUG] Error details:', errorStack);

            // Provide helpful information about common failure causes
            console.error('\n💡 Common causes of diagnosis failures:');
            console.error('   • AWS credentials not configured or expired');
            console.error('   • Insufficient ECS permissions (ecs:DescribeServices, ecs:ListTasks, ecs:DescribeTasks)');
            console.error('   • Network connectivity issues to AWS APIs');
            console.error('   • ECS cluster or services do not exist');
            console.error('   • Region mismatch (services in different region)');

            process.exit(1);
        }
    });

program.parse();
