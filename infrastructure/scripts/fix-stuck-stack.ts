#!/usr/bin/env ts-node

import {
    CloudFormationClient,
    DescribeStacksCommand,
    DescribeStackEventsCommand,
    ContinueUpdateRollbackCommand,
    DeleteStackCommand,
    StackStatus,
    CancelUpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import { ECSClient, ListServicesCommand, DescribeServicesCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import {
    ApplicationAutoScalingClient,
    DescribeScalingPoliciesCommand,
    DeleteScalingPolicyCommand,
    DescribeScalableTargetsCommand,
    DeregisterScalableTargetCommand,
    RegisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';
import {
    ElasticLoadBalancingV2Client,
    DescribeTargetGroupsCommand,
    DeregisterTargetsCommand,
    DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { program } from 'commander';
import { loadEnvironmentConfig, normalizeEnvironmentName } from '../config/environments/shared';

interface StackFixOptions {
    environment: string;
    stackName?: string;
    forceDelete: boolean;
    deleteInProgress: boolean;
    dryRun: boolean;
    skipUnfixable: boolean;
    region?: string;
}

interface ResourceFixResult {
    resource: any;
    fixed: boolean;
    unfixable: boolean;
    reason?: string;
}

class StackFixer {
    private cfClient: CloudFormationClient;
    private ecsClient: ECSClient;
    private elbClient: ElasticLoadBalancingV2Client;
    private autoScalingClient: ApplicationAutoScalingClient;
    private region: string;

    constructor(region: string) {
        this.region = region;
        this.cfClient = new CloudFormationClient({ region: this.region });
        this.ecsClient = new ECSClient({ region: this.region });
        this.elbClient = new ElasticLoadBalancingV2Client({ region: this.region });
        this.autoScalingClient = new ApplicationAutoScalingClient({ region: this.region });
    }

    async fixStuckStacks(options: StackFixOptions): Promise<void> {
        console.log('🔧 Starting stuck stack fix process...');
        console.log(`   Environment: ${options.environment}`);
        console.log(`   Dry run: ${options.dryRun}`);
        console.log(`   Delete in-progress: ${options.deleteInProgress}`);
        console.log(`   Skip unfixable resources: ${options.skipUnfixable}`);

        const stuckStacks = await this.findStuckStacks(options);

        if (stuckStacks.length === 0) {
            console.log('✅ No stuck stacks found');
            return;
        }

        console.log(`\n🔍 Found ${stuckStacks.length} stuck stack(s):`);
        stuckStacks.forEach((stack) => {
            console.log(`   📋 ${stack.StackName}: ${stack.StackStatus} (${this.getTimeSinceUpdate(stack)} ago)`);
        });

        for (const stack of stuckStacks) {
            await this.fixStack(stack, options);
        }
    }

    private async findStuckStacks(options: StackFixOptions): Promise<any[]> {
        try {
            console.log(`🔍 Debug: Looking for stacks with options:`, {
                environment: options.environment,
                normalizedEnv: this.normalizeEnvironment(options.environment),
                stackName: options.stackName,
            });

            const response = await this.cfClient.send(new DescribeStacksCommand({}));
            const stacks = response.Stacks || [];

            console.log(`📊 Debug: Found ${stacks.length} total stacks in AWS`);

            // Show first few stack names for debugging
            if (stacks.length > 0) {
                console.log(`🔍 Debug: Sample stack names:`);
                stacks.slice(0, 5).forEach((stack) => {
                    console.log(`   - ${stack.StackName}`);
                });
                if (stacks.length > 5) {
                    console.log(`   ... and ${stacks.length - 5} more`);
                }
            }

            // Filter stacks for the environment
            const envStacks = stacks.filter((stack) => {
                const nameMatch = stack.StackName?.includes(`-${this.normalizeEnvironment(options.environment)}-`);
                const exactMatch = options.stackName && stack.StackName === options.stackName;

                // Debug logging for specific stack
                if (stack.StackName?.includes('certificate') || stack.StackName === options.stackName) {
                    console.log(`🔍 Debug: Checking stack ${stack.StackName}:`);
                    console.log(
                        `   - Name includes "-${this.normalizeEnvironment(options.environment)}-": ${nameMatch}`,
                    );
                    console.log(`   - Exact match with "${options.stackName}": ${exactMatch}`);
                    console.log(`   - Will include: ${nameMatch || exactMatch}`);
                }

                return nameMatch || exactMatch;
            });

            console.log(`🔍 Found ${envStacks.length} stack(s) for environment: ${options.environment}`);

            // Show all stacks and their states for debugging
            envStacks.forEach((stack) => {
                const updateTime = stack.LastUpdatedTime || stack.CreationTime;
                const minutesAgo = updateTime ? Math.round((Date.now() - updateTime.getTime()) / (1000 * 60)) : 0;
                console.log(`   📋 ${stack.StackName}: ${stack.StackStatus} (${minutesAgo}m ago)`);
            });

            // Find stuck stacks - include all potentially problematic states
            const stuckStates = [
                StackStatus.UPDATE_ROLLBACK_IN_PROGRESS,
                StackStatus.UPDATE_IN_PROGRESS,
                StackStatus.CREATE_IN_PROGRESS,
                StackStatus.DELETE_IN_PROGRESS,
                StackStatus.UPDATE_COMPLETE_CLEANUP_IN_PROGRESS, // BUG FIX: This was missing!
                StackStatus.CREATE_FAILED,
                StackStatus.UPDATE_FAILED,
                StackStatus.UPDATE_ROLLBACK_FAILED,
                StackStatus.DELETE_FAILED,
            ];

            const potentiallyStuckStacks = envStacks.filter((stack) => {
                if (!stack.StackStatus) return false;

                const isStuckState = stuckStates.includes(stack.StackStatus as any);
                if (!isStuckState) return false;

                // For failed states, always consider them stuck
                if (stack.StackStatus.includes('FAILED')) {
                    console.log(`   🚨 Found failed stack: ${stack.StackName} (${stack.StackStatus})`);
                    return true;
                }

                // For in-progress states, consider stuck if operation has been running for more than 30 minutes
                const updateTime = stack.LastUpdatedTime || stack.CreationTime;
                const minutesAgo = updateTime ? (Date.now() - updateTime.getTime()) / (1000 * 60) : 0;

                // If --delete-in-progress flag is set, consider any in-progress stack as stuck
                if (options.deleteInProgress) {
                    console.log(
                        `   🗑️  Found in-progress stack (delete-in-progress enabled): ${stack.StackName} (${
                            stack.StackStatus
                        } for ${Math.round(minutesAgo)}m)`,
                    );
                    return true;
                }

                // Special handling for DELETE_IN_PROGRESS - only consider stuck if it's been running for more than 45 minutes
                if (stack.StackStatus === StackStatus.DELETE_IN_PROGRESS && minutesAgo > 15) {
                    console.log(
                        `   🗑️  Found stuck deletion: ${stack.StackName} (${stack.StackStatus} for ${Math.round(
                            minutesAgo,
                        )}m)`,
                    );
                    return true;
                }

                if (minutesAgo > 30) {
                    console.log(
                        `   ⏰ Found stuck stack: ${stack.StackName} (${stack.StackStatus} for ${Math.round(
                            minutesAgo,
                        )}m)`,
                    );
                    return true;
                }

                // For cleanup states, be more aggressive - consider stuck after 10 minutes
                if (stack.StackStatus === StackStatus.UPDATE_COMPLETE_CLEANUP_IN_PROGRESS && minutesAgo > 10) {
                    console.log(
                        `   🧹 Found stuck cleanup: ${stack.StackName} (${stack.StackStatus} for ${Math.round(
                            minutesAgo,
                        )}m)`,
                    );
                    return true;
                }

                // Give different messages based on stack status
                if (stack.StackStatus === StackStatus.DELETE_IN_PROGRESS) {
                    console.log(
                        `   ⏳ Stack deletion in progress: ${stack.StackName} (${stack.StackStatus} for ${Math.round(
                            minutesAgo,
                        )}m) - will monitor for completion`,
                    );
                } else {
                    console.log(
                        `   ⏳ Stack in progress but not stuck yet: ${stack.StackName} (${
                            stack.StackStatus
                        } for ${Math.round(minutesAgo)}m)`,
                    );
                }
                return false;
            });

            if (potentiallyStuckStacks.length === 0) {
                console.log(`✅ No stuck stacks found (checked ${envStacks.length} stacks)`);
            } else {
                console.log(`🚨 Found ${potentiallyStuckStacks.length} stuck stack(s)`);
            }

            return potentiallyStuckStacks;
        } catch (error) {
            console.error('❌ Failed to describe stacks:', error);
            throw error;
        }
    }

    private async fixStack(stack: any, options: StackFixOptions): Promise<void> {
        console.log(`\n🔧 Attempting to fix stack: ${stack.StackName}`);

        try {
            // Handle DELETE_IN_PROGRESS stacks specially
            if (stack.StackStatus === StackStatus.DELETE_IN_PROGRESS) {
                const updateTime = stack.LastUpdatedTime || stack.CreationTime;
                const minutesAgo = updateTime ? (Date.now() - updateTime.getTime()) / (1000 * 60) : 0;

                if (minutesAgo > 45) {
                    console.log(
                        `   🗑️  Stack deletion appears stuck (${Math.round(
                            minutesAgo,
                        )}m) - attempting to help it along`,
                    );

                    // For stuck deletions, try to identify resources that might be blocking deletion
                    const stuckResources = await this.identifyStuckResources(stack.StackName);

                    if (stuckResources.length > 0) {
                        console.log(
                            `   🔍 Found ${stuckResources.length} resource(s) that might be blocking deletion:`,
                        );
                        stuckResources.forEach((resource) => {
                            console.log(
                                `      - ${resource.LogicalResourceId} (${resource.ResourceType}): ${resource.ResourceStatus}`,
                            );
                        });

                        // For stuck deletions, we don't try to fix resources - we just note them
                        // The deletion process should eventually skip them or handle them
                        console.log(`   ℹ️  Deletion is in progress but may be stuck on the above resources`);
                        console.log(`   💡 Consider manual intervention if this persists for more than 60 minutes`);
                    } else {
                        console.log(`   ℹ️  No obviously stuck resources found - deletion may complete soon`);
                    }
                } else {
                    console.log(
                        `   ✅ Stack deletion is in progress (${Math.round(
                            minutesAgo,
                        )}m) - allowing it to complete naturally`,
                    );
                }
                return;
            }

            // If --delete-in-progress flag is set, go straight to deletion for CREATE/UPDATE in-progress stacks
            if (
                options.deleteInProgress &&
                (stack.StackStatus === StackStatus.CREATE_IN_PROGRESS ||
                    stack.StackStatus === StackStatus.UPDATE_IN_PROGRESS)
            ) {
                console.log(`   🗑️  Delete-in-progress flag set - attempting direct deletion of ${stack.StackName}`);

                // First try to cancel the operation
                try {
                    await this.cancelUpdate(stack.StackName, options);
                    // Wait a bit for the cancellation to take effect
                    await new Promise((resolve) => setTimeout(resolve, 10000));
                } catch (error: any) {
                    // Check if it's the expected cancellation error
                    if (
                        error?.Code === 'ValidationError' &&
                        error?.message?.includes('CancelUpdateStack cannot be called from current stack status')
                    ) {
                        console.log(`   ✅ Cancellation not needed (stack is being created, not updated)`);
                    } else {
                        console.log(`   ⚠️  Could not cancel update, proceeding with deletion anyway`);
                    }
                }

                // Then delete the stack
                if (!options.dryRun) {
                    await this.deleteStack(stack.StackName);
                }
                return;
            }

            // Step 1: Analyze stack events to identify stuck resources
            const stuckResources = await this.identifyStuckResources(stack.StackName);
            let unfixableResources: ResourceFixResult[] = [];

            if (stuckResources.length > 0) {
                console.log(`   🔍 Found ${stuckResources.length} potentially stuck resource(s):`);
                stuckResources.forEach((resource) => {
                    console.log(
                        `      - ${resource.LogicalResourceId} (${resource.ResourceType}): ${resource.ResourceStatus}`,
                    );
                });

                // Step 2: Try to fix stuck resources
                const fixResults = await this.fixStuckResources(stuckResources, options);

                // Step 2.5: Collect unfixable resources
                unfixableResources = fixResults.filter((result) => result.unfixable);
                if (unfixableResources.length > 0) {
                    console.log(`   ⚠️  Found ${unfixableResources.length} unfixable resource(s):`);
                    unfixableResources.forEach((result) => {
                        console.log(
                            `      - ${result.resource.LogicalResourceId}: ${result.reason || 'Cannot be fixed'}`,
                        );
                    });

                    if (options.skipUnfixable) {
                        console.log(`   🔄 Skip-unfixable enabled - will skip these resources during rollback`);
                    } else {
                        console.log(
                            `   💡 Tip: Use --skip-unfixable to automatically skip these resources during rollback`,
                        );
                        console.log(
                            `   💡 This is often the best approach for stuck deployments with missing dependencies`,
                        );
                    }
                }
            }

            // Step 3: Attempt to resolve the stuck state
            if (stack.StackStatus === StackStatus.UPDATE_ROLLBACK_IN_PROGRESS) {
                // If we have unfixable resources and skip-unfixable is enabled, skip them
                const resourcesToSkip = options.skipUnfixable
                    ? unfixableResources.map((result) => result.resource)
                    : [];
                await this.continueRollback(stack.StackName, resourcesToSkip, options);
            } else if (stack.StackStatus === StackStatus.UPDATE_ROLLBACK_FAILED) {
                console.log(`   🚨 Stack rollback failed - attempting to continue rollback`);

                // For UPDATE_ROLLBACK_FAILED, we need to continue the rollback
                // If we have unfixable resources and skip-unfixable is enabled, skip them
                const resourcesToSkip = options.skipUnfixable
                    ? unfixableResources.map((result) => result.resource)
                    : [];

                if (!options.dryRun) {
                    await this.continueRollback(stack.StackName, resourcesToSkip, options);
                }
                return;
            } else if (stack.StackStatus === StackStatus.UPDATE_COMPLETE_CLEANUP_IN_PROGRESS) {
                // For stuck cleanup, the only option is to try cancelling the "update"
                // This can sometimes unblock it.
                try {
                    await this.cancelUpdate(stack.StackName, options);
                } catch (error: any) {
                    // For cleanup operations, cancellation might not be possible
                    if (
                        error?.Code === 'ValidationError' &&
                        error?.message?.includes('CancelUpdateStack cannot be called from current stack status')
                    ) {
                        console.log(`   ℹ️  Cannot cancel cleanup operation - will wait for it to complete naturally`);
                    } else {
                        console.log(`   ⚠️  Could not cancel cleanup operation, this may require manual intervention`);
                    }
                }
            }

            // Step 4: Handle DELETE_FAILED stacks
            if (stack.StackStatus === StackStatus.DELETE_FAILED) {
                console.log(`   🚨 Stack deletion failed - attempting to continue deletion`);

                // For DELETE_FAILED, we need to retry the deletion
                if (!options.dryRun) {
                    await this.deleteStack(stack.StackName);
                }
                return;
            }

            // Step 5: As last resort, delete stack if force delete is enabled
            if (options.forceDelete && !options.dryRun) {
                console.log(`   ⚠️  Force delete enabled - deleting stack ${stack.StackName}`);
                await this.deleteStack(stack.StackName);
            }
        } catch (error) {
            console.error(`❌ Failed to fix stack ${stack.StackName}:`, error);
            throw error;
        }
    }

    private async identifyStuckResources(stackName: string): Promise<any[]> {
        try {
            const response = await this.cfClient.send(new DescribeStackEventsCommand({ StackName: stackName }));
            const events = response.StackEvents || [];

            // Find resources that have been in progress for a long time or failed
            const problematicEvents = events.filter((event) => {
                if (!event.Timestamp) return false;

                const minutesAgo = (Date.now() - event.Timestamp.getTime()) / (1000 * 60);

                // Include resources that are stuck in progress
                if (event.ResourceStatus?.includes('IN_PROGRESS') && minutesAgo > 10) {
                    return true;
                }

                // Include failed resources
                if (event.ResourceStatus?.includes('FAILED')) {
                    return true;
                }

                // Special handling for auto-scaling resources - they get stuck more easily
                if (
                    this.isAutoScalingResource(event) &&
                    event.ResourceStatus?.includes('IN_PROGRESS') &&
                    minutesAgo > 5
                ) {
                    return true;
                }

                return false;
            });

            // Group by resource and get the latest event for each
            const resourceMap = new Map();
            problematicEvents.forEach((event) => {
                const key = event.LogicalResourceId;
                if (!resourceMap.has(key) || (event.Timestamp && resourceMap.get(key).Timestamp < event.Timestamp)) {
                    resourceMap.set(key, event);
                }
            });

            const stuckResources = Array.from(resourceMap.values());

            // Sort by priority - handle auto-scaling resources first
            stuckResources.sort((a, b) => {
                const aIsAutoScaling = this.isAutoScalingResource(a);
                const bIsAutoScaling = this.isAutoScalingResource(b);

                if (aIsAutoScaling && !bIsAutoScaling) return -1;
                if (!aIsAutoScaling && bIsAutoScaling) return 1;

                // Then by resource type priority
                const typePriority = {
                    'AWS::ApplicationAutoScaling::ScalingPolicy': 1,
                    'AWS::ApplicationAutoScaling::ScalableTarget': 2,
                    'AWS::ECS::Service': 3,
                    'AWS::ElasticLoadBalancingV2::TargetGroup': 4,
                    'AWS::ECS::TaskDefinition': 5,
                };

                const aPriority = typePriority[a.ResourceType as keyof typeof typePriority] || 10;
                const bPriority = typePriority[b.ResourceType as keyof typeof typePriority] || 10;

                return aPriority - bPriority;
            });

            return stuckResources;
        } catch (error) {
            console.error(`❌ Failed to get stack events for ${stackName}:`, error);
            return [];
        }
    }

    private isAutoScalingResource(event: any): boolean {
        if (!event.ResourceType || !event.LogicalResourceId) return false;

        // Check by resource type
        if (
            event.ResourceType === 'AWS::ApplicationAutoScaling::ScalingPolicy' ||
            event.ResourceType === 'AWS::ApplicationAutoScaling::ScalableTarget'
        ) {
            return true;
        }

        // Check by logical resource ID patterns
        const logicalId = event.LogicalResourceId;
        return (
            logicalId.includes('TaskCountTarget') ||
            logicalId.includes('CpuScaling') ||
            logicalId.includes('MemoryScaling') ||
            logicalId.includes('AutoScaling')
        );
    }

    private async fixStuckResources(stuckResources: any[], options: StackFixOptions): Promise<ResourceFixResult[]> {
        const results: ResourceFixResult[] = [];

        for (const resource of stuckResources) {
            try {
                console.log(`   🔧 Attempting to fix resource: ${resource.LogicalResourceId}`);

                let result: ResourceFixResult;

                switch (resource.ResourceType) {
                    case 'AWS::ECS::Service':
                        result = await this.fixStuckECSService(resource, options);
                        break;
                    case 'AWS::ElasticLoadBalancingV2::TargetGroup':
                        result = await this.fixStuckTargetGroup(resource, options);
                        break;
                    case 'AWS::ApplicationAutoScaling::ScalingPolicy':
                        result = await this.fixStuckAutoScalingPolicy(resource, options);
                        break;
                    case 'AWS::ApplicationAutoScaling::ScalableTarget':
                        result = await this.fixStuckScalableTarget(resource, options);
                        break;
                    case 'AWS::ECS::TaskDefinition':
                        result = await this.fixStuckTaskDefinition(resource, options);
                        break;
                    default:
                        console.log(`      ⚠️  No specific fix available for ${resource.ResourceType}`);
                        result = {
                            resource,
                            fixed: false,
                            unfixable: true,
                            reason: `No fix available for ${resource.ResourceType}`,
                        };
                }

                results.push(result);
            } catch (error) {
                console.error(`      ❌ Failed to fix resource ${resource.LogicalResourceId}:`, error);
                results.push({
                    resource,
                    fixed: false,
                    unfixable: false,
                    reason: `Fix attempt failed: ${error}`,
                });
            }
        }

        return results;
    }

    private async fixStuckECSService(resource: any, options: StackFixOptions): Promise<ResourceFixResult> {
        try {
            if (options.dryRun) {
                console.log(`      [DRY RUN] Would scale down ECS service ${resource.PhysicalResourceId}`);
                return {
                    resource,
                    fixed: false,
                    unfixable: false,
                    reason: 'Dry run - no action taken',
                };
            }

            // Generate cluster name based on environment
            const clusterName = `v3-backend-${this.normalizeEnvironment(options.environment)}-cluster`;

            console.log(
                `      🔍 Attempting to scale down service ${resource.PhysicalResourceId} in cluster ${clusterName}`,
            );

            // Scale down ECS service to 0 tasks
            await this.ecsClient.send(
                new UpdateServiceCommand({
                    cluster: clusterName,
                    service: resource.PhysicalResourceId,
                    desiredCount: 0,
                }),
            );

            console.log(`      ✅ Scaled down ECS service ${resource.PhysicalResourceId} to 0 tasks`);

            // Wait a bit for the service to scale down
            await new Promise((resolve) => setTimeout(resolve, 30000));

            return {
                resource,
                fixed: true,
                unfixable: false,
                reason: 'Successfully scaled down to 0 tasks',
            };
        } catch (error) {
            console.error(`      ❌ Failed to scale down ECS service:`, error);

            // If cluster doesn't exist, this is expected for stuck deployments
            if (error && (error as any).name === 'ClusterNotFoundException') {
                console.log(
                    `      ℹ️  Cluster ${this.normalizeEnvironment(
                        options.environment,
                    )} not found - this is expected for stuck deployments`,
                );
                console.log(`      ℹ️  The service is stuck because the cluster it references doesn't exist`);

                return {
                    resource,
                    fixed: false,
                    unfixable: true,
                    reason: 'ECS cluster does not exist',
                };
            }

            return {
                resource,
                fixed: false,
                unfixable: false,
                reason: `Failed to scale down: ${error}`,
            };
        }
    }

    private async fixStuckTargetGroup(resource: any, options: StackFixOptions): Promise<ResourceFixResult> {
        try {
            if (options.dryRun) {
                console.log(`      [DRY RUN] Would deregister targets from ${resource.PhysicalResourceId}`);
                return {
                    resource,
                    fixed: false,
                    unfixable: false,
                    reason: 'Dry run - no action taken',
                };
            }

            // Get target health
            const healthResponse = await this.elbClient.send(
                new DescribeTargetHealthCommand({
                    TargetGroupArn: resource.PhysicalResourceId,
                }),
            );

            const targets = healthResponse.TargetHealthDescriptions || [];
            if (targets.length > 0) {
                // Deregister all targets
                await this.elbClient.send(
                    new DeregisterTargetsCommand({
                        TargetGroupArn: resource.PhysicalResourceId,
                        Targets: targets.map((t) => ({ Id: t.Target?.Id!, Port: t.Target?.Port })),
                    }),
                );

                console.log(`      ✅ Deregistered ${targets.length} targets from target group`);

                return {
                    resource,
                    fixed: true,
                    unfixable: false,
                    reason: `Deregistered ${targets.length} targets`,
                };
            } else {
                console.log(`      ℹ️  No targets to deregister from target group`);
                return {
                    resource,
                    fixed: true,
                    unfixable: false,
                    reason: 'No targets to deregister',
                };
            }
        } catch (error) {
            console.error(`      ❌ Failed to fix target group:`, error);
            return {
                resource,
                fixed: false,
                unfixable: false,
                reason: `Failed to fix target group: ${error}`,
            };
        }
    }

    private async fixStuckAutoScalingPolicy(resource: any, options: StackFixOptions): Promise<ResourceFixResult> {
        try {
            if (options.dryRun) {
                console.log(`      [DRY RUN] Would delete auto-scaling policy ${resource.LogicalResourceId}`);
                return {
                    resource,
                    fixed: false,
                    unfixable: false,
                    reason: 'Dry run - no action taken',
                };
            }

            // Extract service name from the resource physical ID or logical ID
            const serviceDimension = this.extractServiceDimensionFromPolicy(resource, options);

            if (!serviceDimension) {
                console.log(`      ⚠️  Cannot determine service dimension for policy ${resource.LogicalResourceId}`);
                return {
                    resource,
                    fixed: false,
                    unfixable: true,
                    reason: 'Cannot determine service dimension for auto-scaling policy',
                };
            }

            console.log(`      🔍 Attempting to delete auto-scaling policy for service: ${serviceDimension}`);

            try {
                // Try to find and delete the scaling policy
                const policiesResponse = await this.autoScalingClient.send(
                    new DescribeScalingPoliciesCommand({
                        ServiceNamespace: 'ecs',
                        ResourceId: serviceDimension,
                    }),
                );

                const policies = policiesResponse.ScalingPolicies || [];
                for (const policy of policies) {
                    if (
                        policy.PolicyName &&
                        policy.PolicyName.includes(resource.LogicalResourceId.replace(/[0-9A-F]{8}$/, ''))
                    ) {
                        await this.autoScalingClient.send(
                            new DeleteScalingPolicyCommand({
                                PolicyName: policy.PolicyName,
                                ServiceNamespace: 'ecs',
                                ResourceId: serviceDimension,
                                ScalableDimension: 'ecs:service:DesiredCount',
                            }),
                        );
                        console.log(`      ✅ Deleted auto-scaling policy: ${policy.PolicyName}`);
                    }
                }

                return {
                    resource,
                    fixed: true,
                    unfixable: false,
                    reason: 'Successfully deleted auto-scaling policy',
                };
            } catch (error: any) {
                if (error.name === 'ObjectNotFoundException' || error.name === 'ValidationException') {
                    console.log(`      ℹ️  Auto-scaling policy already deleted or not found`);
                    return {
                        resource,
                        fixed: true,
                        unfixable: false,
                        reason: 'Auto-scaling policy already deleted',
                    };
                }
                throw error;
            }
        } catch (error) {
            console.error(`      ❌ Failed to fix auto-scaling policy:`, error);
            return {
                resource,
                fixed: false,
                unfixable: true,
                reason: `Failed to delete auto-scaling policy: ${error}`,
            };
        }
    }

    private async fixStuckScalableTarget(resource: any, options: StackFixOptions): Promise<ResourceFixResult> {
        try {
            if (options.dryRun) {
                console.log(
                    `      [DRY RUN] Would handle scalable target state inconsistency ${resource.LogicalResourceId}`,
                );
                return {
                    resource,
                    fixed: false,
                    unfixable: false,
                    reason: 'Dry run - no action taken',
                };
            }

            const serviceDimension = this.extractServiceDimensionFromTarget(resource, options);

            if (!serviceDimension) {
                console.log(
                    `      ⚠️  Cannot determine service dimension for scalable target ${resource.LogicalResourceId}`,
                );
                return {
                    resource,
                    fixed: false,
                    unfixable: true,
                    reason: 'Cannot determine service dimension for scalable target',
                };
            }

            console.log(`      🔍 Checking scalable target state for service: ${serviceDimension}`);

            try {
                // First, check if the scalable target actually exists
                const describeResponse = await this.autoScalingClient.send(
                    new DescribeScalableTargetsCommand({
                        ServiceNamespace: 'ecs',
                        ResourceIds: [serviceDimension],
                        ScalableDimension: 'ecs:service:DesiredCount',
                    }),
                );

                const targets = describeResponse.ScalableTargets || [];

                if (targets.length === 0) {
                    console.log(`      🔍 Scalable target doesn't exist in AWS but CloudFormation thinks it does`);
                    console.log(`      🔧 Creating missing scalable target to resolve state inconsistency`);

                    // Create the missing scalable target with minimal configuration
                    await this.autoScalingClient.send(
                        new RegisterScalableTargetCommand({
                            ServiceNamespace: 'ecs',
                            ResourceId: serviceDimension,
                            ScalableDimension: 'ecs:service:DesiredCount',
                            MinCapacity: 1,
                            MaxCapacity: 3, // Use development defaults
                        }),
                    );

                    console.log(`      ✅ Created missing scalable target - CloudFormation can now update it`);

                    return {
                        resource,
                        fixed: true,
                        unfixable: false,
                        reason: 'Created missing scalable target to resolve state inconsistency',
                    };
                } else {
                    console.log(`      ℹ️  Scalable target exists - CloudFormation should be able to update it`);
                    return {
                        resource,
                        fixed: true,
                        unfixable: false,
                        reason: 'Scalable target exists and should be updateable',
                    };
                }
            } catch (error: any) {
                if (error.name === 'ObjectNotFoundException' || error.name === 'ValidationException') {
                    console.log(`      ℹ️  Scalable target service doesn't exist - will be skipped during rollback`);
                    return {
                        resource,
                        fixed: false,
                        unfixable: true,
                        reason: 'ECS service does not exist for scalable target',
                    };
                }
                throw error;
            }
        } catch (error) {
            console.error(`      ❌ Failed to fix scalable target:`, error);
            return {
                resource,
                fixed: false,
                unfixable: true,
                reason: `Failed to handle scalable target: ${error}`,
            };
        }
    }

    private async fixStuckTaskDefinition(resource: any, options: StackFixOptions): Promise<ResourceFixResult> {
        // Task definitions that are stuck are usually due to dependency issues
        // They can typically be safely skipped during rollback
        console.log(`      ℹ️  Task definition ${resource.LogicalResourceId} will be marked for skipping`);
        return {
            resource,
            fixed: false,
            unfixable: true,
            reason: 'Task definitions should be skipped during rollback as they have no running state',
        };
    }

    private extractServiceDimensionFromPolicy(resource: any, options: StackFixOptions): string | null {
        // Extract service dimension from auto-scaling policy resource
        // Format: cluster/service-name or service/cluster-name/service-name
        const clusterName = `v3-backend-${this.normalizeEnvironment(options.environment)}-cluster`;

        // Try to map from logical resource ID to service name
        if (resource.LogicalResourceId.includes('ApiService')) {
            return `service/${clusterName}/v3-backend-${this.normalizeEnvironment(options.environment)}-api-service`;
        } else if (resource.LogicalResourceId.includes('WorkerService')) {
            return `service/${clusterName}/v3-backend-${this.normalizeEnvironment(options.environment)}-worker-service`;
        } else if (resource.LogicalResourceId.includes('SchedulerService')) {
            return `service/${clusterName}/v3-backend-${this.normalizeEnvironment(
                options.environment,
            )}-scheduler-service`;
        }

        return null;
    }

    private extractServiceDimensionFromTarget(resource: any, options: StackFixOptions): string | null {
        // Similar logic for scalable targets
        return this.extractServiceDimensionFromPolicy(resource, options);
    }

    private async continueRollback(stackName: string, stuckResources: any[], options: StackFixOptions): Promise<void> {
        try {
            console.log(`   🔄 Attempting to continue rollback for ${stackName}`);

            // Filter out invalid resources for skipping
            const validResourcesToSkip = stuckResources.filter((resource) => {
                // Can't skip the stack itself
                if (resource.ResourceType === 'AWS::CloudFormation::Stack') {
                    console.log(`      ℹ️  Skipping stack resource itself: ${resource.LogicalResourceId}`);
                    return false;
                }

                // Can't skip nested stacks (if any)
                if (resource.LogicalResourceId === stackName) {
                    console.log(`      ℹ️  Skipping self-reference: ${resource.LogicalResourceId}`);
                    return false;
                }

                return true;
            });

            if (options.dryRun) {
                console.log(
                    `      [DRY RUN] Would continue rollback${
                        validResourcesToSkip.length > 0 ? ` and skip ${validResourcesToSkip.length} resources` : ''
                    }`,
                );
                if (validResourcesToSkip.length > 0) {
                    console.log(`      [DRY RUN] Resources to skip:`);
                    validResourcesToSkip.forEach((resource) => {
                        console.log(`         - ${resource.LogicalResourceId} (${resource.ResourceType})`);
                    });
                }
                return;
            }

            if (validResourcesToSkip.length > 0) {
                console.log(`   📋 Will skip ${validResourcesToSkip.length} resources:`);
                validResourcesToSkip.forEach((resource) => {
                    console.log(`      - ${resource.LogicalResourceId} (${resource.ResourceType})`);
                });
            }

            const command = new ContinueUpdateRollbackCommand({
                StackName: stackName,
                ...(validResourcesToSkip.length > 0 && {
                    ResourcesToSkip: validResourcesToSkip.map((r) => r.LogicalResourceId),
                }),
            });

            await this.cfClient.send(command);
            console.log(`   ✅ Successfully initiated rollback continuation`);
        } catch (error) {
            console.error(`   ❌ Failed to continue rollback:`, error);
            throw error;
        }
    }

    private async deleteStack(stackName: string): Promise<void> {
        try {
            await this.cfClient.send(new DeleteStackCommand({ StackName: stackName }));
            console.log(`   ✅ Successfully initiated stack deletion`);
        } catch (error) {
            console.error(`   ❌ Failed to delete stack:`, error);
            throw error;
        }
    }

    private async cancelUpdate(stackName: string, options: StackFixOptions): Promise<void> {
        try {
            console.log(`   🔄 Attempting to cancel update for ${stackName} to unblock cleanup`);

            if (options.dryRun) {
                console.log(`      [DRY RUN] Would cancel update for ${stackName}`);
                return;
            }

            await this.cfClient.send(
                new CancelUpdateStackCommand({
                    StackName: stackName,
                }),
            );

            console.log(`   ✅ Successfully initiated cancellation for stack: ${stackName}`);
        } catch (error: any) {
            // Handle expected cancellation errors gracefully
            if (
                error?.Code === 'ValidationError' &&
                error?.message?.includes('CancelUpdateStack cannot be called from current stack status')
            ) {
                console.log(
                    `   ℹ️  Cannot cancel: Stack is not in UPDATE_IN_PROGRESS state (this is expected for CREATE operations)`,
                );
            } else {
                console.error(`   ❌ Failed to cancel update:`, error);
            }
            throw error; // Re-throw so calling code can handle it
        }
    }

    private normalizeEnvironment(env: string): string {
        return normalizeEnvironmentName(env);
    }

    private getTimeSinceUpdate(stack: any): string {
        const updateTime = stack.LastUpdatedTime || stack.CreationTime;
        if (!updateTime) return 'unknown';

        const minutesAgo = Math.floor((Date.now() - updateTime.getTime()) / (1000 * 60));
        if (minutesAgo < 60) return `${minutesAgo}m`;

        const hoursAgo = Math.floor(minutesAgo / 60);
        return `${hoursAgo}h ${minutesAgo % 60}m`;
    }
}

// CLI setup
program
    .name('fix-stuck-stack')
    .description('Fix stuck CloudFormation stacks')
    .requiredOption('-e, --environment <env>', 'Environment (dev/staging/prod)')
    .option('-s, --stack-name <name>', 'Specific stack name to fix')
    .option('--force-delete', 'Force delete stack as last resort', false)
    .option('--delete-in-progress', 'Delete stacks that are currently in progress (any duration)', false)
    .option(
        '--skip-unfixable',
        'Automatically skip resources that cannot be fixed (e.g., ECS services without clusters)',
        false,
    )
    .option('--dry-run', 'Show what would be done without making changes', false);

program.parse();

const options = program.opts() as Omit<StackFixOptions, 'region'>;

async function main() {
    try {
        // Load environment config to get the correct region
        const config = await loadEnvironmentConfig(options.environment);
        const region = config.region || process.env.AWS_REGION || 'us-east-1';

        const fixer = new StackFixer(region);

        const fullOptions: StackFixOptions = { ...options, region, skipUnfixable: options.skipUnfixable || false };

        await fixer.fixStuckStacks(fullOptions);

        console.log('\n✅ Stack fix process completed');
    } catch (error) {
        console.error('\n❌ Stack fix process failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
