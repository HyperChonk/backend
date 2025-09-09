#!/usr/bin/env ts-node

import {
    ECSClient,
    UpdateServiceCommand,
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    RegisterTaskDefinitionCommand,
    TaskDefinition,
} from '@aws-sdk/client-ecs';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { program } from 'commander';
import { PromotionTracker } from './promotion-tracker';
import { normalizeEnvironmentName } from '../config/environments/shared';

interface CodeDeploymentConfig {
    environment: string;
    imageUri: string;
    imageTag: string;
    deploymentId: string;
    region?: string;
    promotedBy?: string;
    sourceEnvironment?: string;
    workflowRunId?: string;
    gitSha?: string;
    secrets?: string;
}

interface ServiceInfo {
    cluster: string;
    services: {
        api: string;
        worker: string;
        scheduler: string;
    };
}

async function updateImageTagParameter(config: CodeDeploymentConfig): Promise<void> {
    const ssmClient = new SSMClient({ region: config.region || 'us-east-1' });

    try {
        await ssmClient.send(
            new PutParameterCommand({
                Name: `/v3-backend/${config.environment}/compute/currentImageTag`,
                Value: config.imageTag,
                Type: 'String',
                Overwrite: true,
                Description: `Current Docker image tag for ${config.environment} environment - Updated by code deployment`,
            }),
        );

        console.log(`✅ Updated SSM parameter with image tag: ${config.imageTag}`);
    } catch (error) {
        console.error(`❌ Failed to update SSM parameter:`, error);
        throw error;
    }
}

async function checkServiceHealth(
    ecsClient: ECSClient,
    cluster: string,
    serviceName: string,
    isCritical: boolean = true,
): Promise<boolean> {
    try {
        const response = await ecsClient.send(
            new DescribeServicesCommand({
                cluster,
                services: [serviceName],
            }),
        );

        const service = response.services?.[0];
        if (!service) {
            console.log(`⚠️  Service ${serviceName} not found`);
            return false;
        }

        const runningCount = service.runningCount || 0;
        const desiredCount = service.desiredCount || 0;
        const serviceType = isCritical ? 'CRITICAL' : 'NON-CRITICAL';

        // Debug output for service deployments
        console.log(`🔍 [${serviceType}] ${serviceName} - Deployment states:`);
        service.deployments?.forEach((dep, index) => {
            console.log(`  Deployment ${index + 1}:`);
            console.log(`    Status: ${dep.status}`);
            console.log(`    Running: ${dep.runningCount}/${dep.desiredCount}`);
            console.log(`    Created: ${dep.createdAt?.toISOString()}`);
            console.log(`    Updated: ${dep.updatedAt?.toISOString()}`);
        });

        // For code deployments, focus on whether the correct number of tasks are running
        const isHealthy = runningCount >= desiredCount && desiredCount > 0;

        console.log(
            `📊 [${serviceType}] ${serviceName}: ${runningCount}/${desiredCount} tasks running, healthy: ${isHealthy}`,
        );

        return isHealthy;
    } catch (error) {
        console.error(`❌ Failed to check service health for ${serviceName}:`, error);
        return false;
    }
}

async function updateEcsService(
    ecsClient: ECSClient,
    cluster: string,
    serviceName: string,
    deploymentId: string,
    config: CodeDeploymentConfig,
    secrets?: string,
): Promise<void> {
    try {
        console.log(`🚀 Updating service: ${serviceName}`);

        // Always create a new task definition revision with the updated image
        // This guarantees each deployment has an immutable task definition that references the exact image tag

        // 1) Read current task definition from the service
        const serviceDesc = await ecsClient.send(new DescribeServicesCommand({ cluster, services: [serviceName] }));
        const currentTaskDefArn = serviceDesc.services?.[0]?.taskDefinition;
        if (!currentTaskDefArn) {
            throw new Error(`Could not find task definition for service ${serviceName}`);
        }
        console.log(`Current task definition ARN: ${currentTaskDefArn}`);

        // 2) Describe the current task definition
        const taskDefDesc = await ecsClient.send(
            new DescribeTaskDefinitionCommand({ taskDefinition: currentTaskDefArn }),
        );
        const currentTaskDef = taskDefDesc.taskDefinition;
        if (!currentTaskDef) {
            throw new Error(`Could not describe task definition ${currentTaskDefArn}`);
        }

        // 3) Build new container definitions
        let providedSecrets: Record<string, string> | undefined;
        try {
            providedSecrets = secrets ? (JSON.parse(secrets) as Record<string, string>) : undefined;
        } catch (e) {
            console.warn(`⚠️ Failed to parse provided secrets JSON for ${serviceName}. Continuing without overrides.`);
        }

        const newContainerDefs = currentTaskDef.containerDefinitions?.map((container) => {
            // Start from previous configuration and update the image
            const updatedContainer: any = { ...container, image: config.imageUri };

            // Merge environment variables, giving precedence to provided secrets
            const envMap: Record<string, string> = {};
            for (const envVar of container.environment || []) {
                if (envVar?.name) {
                    envMap[envVar.name] = String(envVar.value ?? '');
                }
            }

            // Avoid duplicating sensitive vars: if a var is already sourced from Secrets Manager,
            // ensure we do NOT also include it in plain environment variables
            const secretNames = new Set<string>(
                (container.secrets || [])
                    .map((s: any) => s?.name)
                    .filter((n: any): n is string => typeof n === 'string' && n.length > 0),
            );

            for (const name of secretNames) {
                delete envMap[name];
            }

            if (providedSecrets) {
                for (const [name, value] of Object.entries(providedSecrets)) {
                    // Respect secret-managed vars; don't override them via plain environment
                    if (!secretNames.has(name)) {
                        envMap[name] = String(value);
                    }
                }
            }

            // Always embed deployment metadata for traceability
            envMap.DEPLOY_IMAGE_TAG = config.imageTag;
            if (config.gitSha) {
                envMap.DEPLOY_GIT_SHA = config.gitSha;
            }

            // Convert back to ECS environment list
            updatedContainer.environment = Object.entries(envMap).map(([name, value]) => ({ name, value }));

            return updatedContainer;
        });

        const newTaskDefInput = {
            family: currentTaskDef.family!,
            containerDefinitions: newContainerDefs,
            cpu: currentTaskDef.cpu,
            memory: currentTaskDef.memory,
            executionRoleArn: currentTaskDef.executionRoleArn,
            taskRoleArn: currentTaskDef.taskRoleArn,
            networkMode: currentTaskDef.networkMode,
            volumes: currentTaskDef.volumes,
            placementConstraints: currentTaskDef.placementConstraints,
            requiresCompatibilities: currentTaskDef.requiresCompatibilities,
            runtimePlatform: currentTaskDef.runtimePlatform,
            pidMode: (currentTaskDef as any).pidMode,
            ipcMode: (currentTaskDef as any).ipcMode,
            inferenceAccelerators: (currentTaskDef as any).inferenceAccelerators,
            ephemeralStorage: (currentTaskDef as any).ephemeralStorage,
            proxyConfiguration: (currentTaskDef as any).proxyConfiguration,
        } as any;

        // 4) Register the new task definition
        const registeredTaskDef = await ecsClient.send(new RegisterTaskDefinitionCommand(newTaskDefInput));
        const newTaskDefArn = registeredTaskDef.taskDefinition?.taskDefinitionArn;
        if (!newTaskDefArn) {
            throw new Error('Failed to register new task definition');
        }
        console.log(`✅ Registered new task definition: ${newTaskDefArn}`);

        // 5) Update the service to use the new revision
        await ecsClient.send(
            new UpdateServiceCommand({
                cluster,
                service: serviceName,
                taskDefinition: newTaskDefArn,
                forceNewDeployment: true,
            }),
        );

        console.log(`📝 Deployment ID: ${deploymentId}`);
        console.log(`⏰ Deployment time: ${new Date().toISOString()}`);
        console.log(`✅ Successfully triggered deployment for ${serviceName}`);
    } catch (error) {
        console.error(`❌ Failed to update service ${serviceName}:`, error);
        throw error;
    }
}

async function waitForServicesStable(
    ecsClient: ECSClient,
    serviceInfo: ServiceInfo,
    timeoutMinutes: number = 10,
): Promise<void> {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const startTime = Date.now();
    const checkInterval = 30 * 1000; // Check every 30 seconds

    console.log(`⏳ Waiting for critical services to stabilize (timeout: ${timeoutMinutes} minutes)...`);

    while (Date.now() - startTime < timeoutMs) {
        // Check critical services first (must be stable for deployment success)
        const criticalChecks = await Promise.all([
            checkServiceHealth(ecsClient, serviceInfo.cluster, serviceInfo.services.api, true),
            checkServiceHealth(ecsClient, serviceInfo.cluster, serviceInfo.services.worker, true),
        ]);

        // Check non-critical services (don't block deployment)
        const nonCriticalChecks = await Promise.all([
            checkServiceHealth(ecsClient, serviceInfo.cluster, serviceInfo.services.scheduler, false),
        ]);

        const criticalStable = criticalChecks.every((healthy) => healthy);
        const nonCriticalStable = nonCriticalChecks.every((healthy) => healthy);

        if (criticalStable) {
            console.log('✅ All critical services are stable and healthy');

            if (nonCriticalStable) {
                console.log('✅ All non-critical services are also stable');
            } else {
                console.log('⚠️ Some non-critical services are still stabilizing (not blocking deployment)');
            }

            return;
        }

        console.log(`⏳ Critical services not yet stable, waiting ${checkInterval / 1000}s before next check...`);
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    throw new Error(`❌ Critical services did not stabilize within ${timeoutMinutes} minutes`);
}

export async function deployCodeOnly(config: CodeDeploymentConfig): Promise<void> {
    console.log('🚀 Starting code-only deployment...');
    console.log(`📊 Environment: ${config.environment}`);
    console.log(`📦 Image URI: ${config.imageUri}`);
    console.log(`🏷️  Image Tag: ${config.imageTag}`);
    console.log(`🆔 Deployment ID: ${config.deploymentId}`);

    const normalizedEnvironment = normalizeEnvironmentName(config.environment);
    const serviceInfo = {
        cluster: `v3-backend-${normalizedEnvironment}-cluster`,
        services: {
            api: `v3-backend-${normalizedEnvironment}-api-service`,
            worker: `v3-backend-${normalizedEnvironment}-worker-service`,
            scheduler: `v3-backend-${normalizedEnvironment}-scheduler-service`,
        },
    };

    const ecsClient = new ECSClient({ region: config.region || 'us-east-1' });

    try {
        // Update SSM parameter first
        await updateImageTagParameter(config);

        // Update API service first (handles migrations)
        console.log('🔄 Updating API service first to ensure migrations run...');
        await updateEcsService(
            ecsClient,
            serviceInfo.cluster,
            serviceInfo.services.api,
            config.deploymentId,
            config,
            config.secrets,
        );

        // Wait for API service to stabilize before updating dependent services
        console.log('⏳ Waiting for API service to stabilize (ensures migrations complete)...');
        const stabilizationTimeout = 120000; // 2 minutes
        const startTime = Date.now();

        while (Date.now() - startTime < stabilizationTimeout) {
            const apiHealthy = await checkServiceHealth(
                ecsClient,
                serviceInfo.cluster,
                serviceInfo.services.api,
                false,
            );
            if (apiHealthy) {
                console.log('✅ API service is stable, migrations should be complete');
                break;
            }
            console.log('⏳ API service not yet stable, waiting 30 seconds...');
            await new Promise((resolve) => setTimeout(resolve, 30000));
        }

        // Now update worker and scheduler services in parallel
        console.log('🔄 Updating worker and scheduler services...');
        await Promise.all([
            updateEcsService(
                ecsClient,
                serviceInfo.cluster,
                serviceInfo.services.worker,
                config.deploymentId,
                config,
                config.secrets,
            ),
            updateEcsService(
                ecsClient,
                serviceInfo.cluster,
                serviceInfo.services.scheduler,
                config.deploymentId,
                config,
                config.secrets,
            ),
        ]);

        console.log('✅ All services deployment triggered successfully');

        // Wait for services to stabilize
        await waitForServicesStable(ecsClient, serviceInfo);

        // Record the promotion
        const promotionTracker = new PromotionTracker(config.region || 'us-east-1');
        await promotionTracker.recordPromotion({
            imageTag: config.imageTag,
            environment: config.environment,
            promotedAt: new Date().toISOString(),
            promotedBy: config.promotedBy || 'deploy-code-only',
            sourceEnvironment: config.sourceEnvironment,
            deploymentId: config.deploymentId,
            workflowRunId: config.workflowRunId,
            gitSha: config.gitSha,
        });

        console.log('🎉 Code-only deployment completed successfully!');
    } catch (error) {
        console.error('❌ Code-only deployment failed:', error);
        throw error;
    }
}

// CLI interface
if (require.main === module) {
    program
        .name('deploy-code-only')
        .description('Deploy code changes without infrastructure updates')
        .requiredOption('--environment <env>', 'Target environment (development, staging, production)')
        .requiredOption('--image-uri <uri>', 'Docker image URI to deploy')
        .requiredOption('--image-tag <tag>', 'Docker image tag')
        .requiredOption('--deployment-id <id>', 'Deployment identifier')
        .option('--region <region>', 'AWS region', 'us-east-1')
        .option('--promoted-by <user>', 'User who promoted the image')
        .option('--source-environment <env>', 'Source environment for promotion tracking')
        .option('--workflow-run-id <id>', 'GitHub workflow run ID')
        .option('--git-sha <sha>', 'Git commit SHA')
        .option('--secrets <json>', 'JSON string of secrets to inject as environment variables')
        .action(async (options) => {
            try {
                await deployCodeOnly({
                    environment: options.environment,
                    imageUri: options.imageUri,
                    imageTag: options.imageTag,
                    deploymentId: options.deploymentId,
                    region: options.region,
                    promotedBy: options.promotedBy,
                    sourceEnvironment: options.sourceEnvironment,
                    workflowRunId: options.workflowRunId,
                    gitSha: options.gitSha,
                    secrets: options.secrets,
                });
                process.exit(0);
            } catch (error) {
                console.error('Deployment failed:', error);
                process.exit(1);
            }
        });

    program.parse();
}
