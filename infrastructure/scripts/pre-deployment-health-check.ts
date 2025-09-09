#!/usr/bin/env ts-node

import {
    CloudFormationClient,
    DescribeStacksCommand,
    CancelUpdateStackCommand,
    StackStatus,
    ListStackResourcesCommand,
    ContinueUpdateRollbackCommand,
} from '@aws-sdk/client-cloudformation';
import { ECSClient, DescribeServicesCommand, DescribeClustersCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { normalizeEnvironmentName } from '../config/environments/shared';

const cfClient = new CloudFormationClient({ region: process.env.AWS_REGION || 'us-east-1' });
const ecsClient = new ECSClient({ region: process.env.AWS_REGION || 'us-east-1' });

interface HealthCheckResult {
    healthy: boolean;
    issues: string[];
    actions: string[];
    canProceed: boolean;
}

interface StackIssue {
    stackName: string;
    status: StackStatus;
    stuckDurationMinutes: number;
    recommendedAction: 'cancel' | 'wait' | 'none';
}

interface ECSIssue {
    serviceName: string;
    clusterName: string;
    issue: string;
    deploymentStuckMinutes?: number;
    runningTasks: number;
    totalTasks: number;
}

async function getStackStatus(stackName: string): Promise<{ status: StackStatus | null; lastUpdated: Date | null }> {
    try {
        const response = await cfClient.send(new DescribeStacksCommand({ StackName: stackName }));
        const stack = response.Stacks?.[0];
        return {
            status: (stack?.StackStatus as StackStatus) || null,
            lastUpdated: stack?.LastUpdatedTime || stack?.CreationTime || null,
        };
    } catch (error) {
        if ((error as any).name === 'ValidationError') {
            return { status: null, lastUpdated: null };
        }
        throw error;
    }
}

async function checkCloudFormationHealth(environment: string): Promise<StackIssue[]> {
    console.log(`🔍 Checking CloudFormation stack health for ${environment}...`);

    const stackNames = [
        `v3-backend-${environment}-networking`,
        `v3-backend-${environment}-database`,
        `v3-backend-${environment}-compute`,
        `v3-backend-${environment}-log-forwarder`,
        `v3-backend-${environment}-monitoring`,
    ];

    const issues: StackIssue[] = [];

    for (const stackName of stackNames) {
        const { status, lastUpdated } = await getStackStatus(stackName);

        if (!status || !lastUpdated) {
            console.log(`   📋 ${stackName}: Does not exist`);
            continue;
        }

        const minutesSinceUpdate = (Date.now() - lastUpdated.getTime()) / (1000 * 60);
        console.log(`   📋 ${stackName}: ${status} (${Math.round(minutesSinceUpdate)}m ago)`);

        // Check for stuck operations
        if (status.includes('IN_PROGRESS')) {
            let recommendedAction: 'cancel' | 'wait' | 'none' = 'none';

            // If stuck for >10 minutes, recommend cancellation
            if (minutesSinceUpdate > 10) {
                recommendedAction = 'cancel';
            } else if (minutesSinceUpdate > 5) {
                recommendedAction = 'wait';
            }

            issues.push({
                stackName,
                status,
                stuckDurationMinutes: minutesSinceUpdate,
                recommendedAction,
            });
        }

        // Check for failed states that need attention
        if (['CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'].includes(status)) {
            issues.push({
                stackName,
                status,
                stuckDurationMinutes: minutesSinceUpdate,
                recommendedAction: 'none', // Manual intervention needed
            });
        }

        // Check for failed rollback that can be fixed
        if (status === 'UPDATE_ROLLBACK_FAILED') {
            issues.push({
                stackName,
                status,
                stuckDurationMinutes: minutesSinceUpdate,
                recommendedAction: 'cancel', // 'cancel' will trigger the auto-fix
            });
        }
    }

    return issues;
}

async function checkECSHealth(environment: string, recentRollback: boolean = false): Promise<ECSIssue[]> {
    console.log(`🔍 Checking ECS service health for ${environment}...`);

    const clusterName = `v3-backend-${environment}-cluster`;
    const serviceNames = [
        `v3-backend-${environment}-api-service`,
        `v3-backend-${environment}-background-processor-service`,
    ];

    const issues: ECSIssue[] = [];

    try {
        // Check if cluster exists
        const clusterResponse = await ecsClient.send(new DescribeClustersCommand({ clusters: [clusterName] }));

        if (!clusterResponse.clusters?.[0]) {
            console.log(`   📋 Cluster ${clusterName}: Does not exist`);
            return issues;
        }

        // Check services
        const servicesResponse = await ecsClient.send(
            new DescribeServicesCommand({
                cluster: clusterName,
                services: serviceNames,
            }),
        );

        for (const service of servicesResponse.services || []) {
            const serviceName = service.serviceName!;
            const runningCount = service.runningCount || 0;
            const desiredCount = service.desiredCount || 0;

            console.log(`   📋 ${serviceName}: ${runningCount}/${desiredCount} running`);

            // Check for zero running tasks (critical issue)
            if (desiredCount > 0 && runningCount === 0) {
                if (recentRollback) {
                    // After a rollback, services need time to start - this is warning, not critical
                    issues.push({
                        serviceName,
                        clusterName,
                        issue: 'Service is starting up after rollback (0 running tasks)',
                        runningTasks: runningCount,
                        totalTasks: desiredCount,
                    });
                } else {
                    // Normal case - service down is critical
                    issues.push({
                        serviceName,
                        clusterName,
                        issue: 'Service is completely down (0 running tasks)',
                        runningTasks: runningCount,
                        totalTasks: desiredCount,
                    });
                }
            }

            // Check for stuck deployments
            for (const deployment of service.deployments || []) {
                if (deployment.status === 'PENDING' || deployment.status === 'RUNNING') {
                    const deploymentAge = deployment.createdAt
                        ? (Date.now() - deployment.createdAt.getTime()) / (1000 * 60)
                        : 0;

                    if (deploymentAge > 10) {
                        issues.push({
                            serviceName,
                            clusterName,
                            issue: `Deployment stuck in ${deployment.status} for ${Math.round(deploymentAge)} minutes`,
                            deploymentStuckMinutes: deploymentAge,
                            runningTasks: runningCount,
                            totalTasks: desiredCount,
                        });
                    }
                }
            }
        }
    } catch (error) {
        console.log(`   ⚠️  Could not check ECS health: ${error}`);
    }

    return issues;
}

async function continueUpdateRollback(stackName: string): Promise<boolean> {
    console.log(`🛠️  Attempting to continue rollback for ${stackName}...`);
    try {
        // Dynamically discover failed resources to skip
        const failedResourceIds: string[] = [];
        try {
            const listResp = await cfClient.send(new ListStackResourcesCommand({ StackName: stackName }));
            (listResp.StackResourceSummaries || []).forEach((r) => {
                const status = r.ResourceStatus as string | undefined;
                if (
                    status &&
                    (status.endsWith('FAILED') ||
                        status.endsWith('ROLLBACK_FAILED') ||
                        status === 'UPDATE_ROLLBACK_IN_PROGRESS')
                ) {
                    if (r.LogicalResourceId) failedResourceIds.push(r.LogicalResourceId);
                }
            });
        } catch (e) {
            console.warn(`⚠️  Could not list stack resources for ${stackName}: ${e}`);
        }

        // Attempt continue-update-rollback via SDK (resourcesToSkip optional)
        await cfClient.send(
            new ContinueUpdateRollbackCommand({
                StackName: stackName,
                ResourcesToSkip: failedResourceIds.length > 0 ? failedResourceIds : undefined,
            }),
        );
        console.log(`✅ Successfully initiated continue-update-rollback for ${stackName}`);
        return true;
    } catch (err: any) {
        const msg = String(err?.message || err);
        if (/is not in state UPDATE_ROLLBACK/i.test(msg) || /No updates are to be performed/i.test(msg)) {
            console.warn(`ℹ️  Continue rollback not applicable for ${stackName}: ${msg}`);
            return true; // Do not block if CFN says nothing to do
        }
        console.error(`❌ Failed to initiate continue-update-rollback for ${stackName}:`, err);
        return false;
    }
}

async function cancelStuckCloudFormationOperation(stackName: string): Promise<boolean> {
    console.log(`🛑 Cancelling stuck CloudFormation operation for ${stackName}...`);

    try {
        // First check the current status
        const { status } = await getStackStatus(stackName);

        if (status === 'UPDATE_ROLLBACK_FAILED') {
            console.log(`⚠️  Stack ${stackName} is in UPDATE_ROLLBACK_FAILED state.`);
            return await continueUpdateRollback(stackName);
        }

        if (status === 'UPDATE_ROLLBACK_IN_PROGRESS') {
            console.log(`⚠️  Stack ${stackName} is already in rollback. Attempting to continue rollback (SDK)...`);

            try {
                // Only resources in UPDATE_FAILED may be skipped
                const failedResourceIds: string[] = [];
                const listResp = await cfClient.send(new ListStackResourcesCommand({ StackName: stackName }));
                (listResp.StackResourceSummaries || []).forEach((r) => {
                    const rStatus = r.ResourceStatus as string | undefined;
                    if (rStatus === 'UPDATE_FAILED' && r.LogicalResourceId) {
                        failedResourceIds.push(r.LogicalResourceId);
                    }
                });

                await cfClient.send(
                    new ContinueUpdateRollbackCommand({
                        StackName: stackName,
                        ResourcesToSkip: failedResourceIds.length > 0 ? failedResourceIds : undefined,
                    }),
                );

                console.log(`✅ Successfully continued rollback for ${stackName}`);
                return true;
            } catch (err: any) {
                const msg = String(err?.message || err);
                console.log(
                    `⚠️  Continue rollback attempt via SDK failed for ${stackName}: ${msg}. Manual intervention may be needed.`,
                );
                return false;
            }
        }

        await cfClient.send(new CancelUpdateStackCommand({ StackName: stackName }));
        console.log(`✅ Successfully cancelled operation for ${stackName}`);
        return true;
    } catch (error: any) {
        if (error.Code === 'ValidationError' && error.message?.includes('CancelUpdateStack cannot be called')) {
            console.log(`⚠️  Cannot cancel ${stackName}: ${error.message}`);
            console.log(
                `💡 Stack may be in rollback. Try: aws cloudformation continue-update-rollback --stack-name ${stackName}`,
            );
            console.log(`💡 Or wait for the rollback to complete naturally.`);
            return false;
        }
        console.error(`❌ Failed to cancel operation for ${stackName}:`, error);
        return false;
    }
}

async function waitForStackStable(stackName: string, maxWaitMinutes: number = 15): Promise<boolean> {
    console.log(`⏳ Waiting for ${stackName} to stabilize (max ${maxWaitMinutes} minutes)...`);

    const maxAttempts = (maxWaitMinutes * 60) / 30; // Check every 30 seconds
    let attempts = 0;

    while (attempts < maxAttempts) {
        const { status } = await getStackStatus(stackName);
        console.log(`   ${stackName}: ${status} (${attempts + 1}/${maxAttempts})`);

        if (!status) {
            return false;
        }

        if (['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(status)) {
            console.log(`✅ ${stackName} is stable`);
            return true;
        }

        if (['CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'].includes(status)) {
            console.log(`❌ ${stackName} failed with status: ${status}`);
            return false;
        }

        // If rollback failed persists and is old, avoid hanging indefinitely
        if (status === 'UPDATE_ROLLBACK_FAILED' && attempts > 2) {
            console.warn(`⚠️  ${stackName} remains in UPDATE_ROLLBACK_FAILED. Proceeding without waiting.`);
            return false;
        }

        await new Promise((resolve) => setTimeout(resolve, 30000));
        attempts++;
    }

    console.log(`⏰ Timeout waiting for ${stackName} to stabilize`);
    return false;
}

async function checkForRecentRollback(environment: string): Promise<boolean> {
    const stackNames = [
        `v3-backend-${environment}-networking`,
        `v3-backend-${environment}-database`,
        `v3-backend-${environment}-compute`,
        `v3-backend-${environment}-log-forwarder`,
        `v3-backend-${environment}-monitoring`,
    ];

    for (const stackName of stackNames) {
        const { status, lastUpdated } = await getStackStatus(stackName);

        if (status === 'UPDATE_ROLLBACK_COMPLETE' && lastUpdated) {
            const minutesSinceRollback = (Date.now() - lastUpdated.getTime()) / (1000 * 60);
            // Consider a rollback "recent" if it happened in the last 10 minutes
            if (minutesSinceRollback < 10) {
                console.log(
                    `🔄 Recent rollback detected: ${stackName} completed ${Math.round(
                        minutesSinceRollback,
                    )} minutes ago`,
                );
                return true;
            }
        }
    }

    return false;
}

async function performHealthCheck(
    environment: string,
    autoFix: boolean = false,
    skipEcsAfterRollback: boolean = false,
): Promise<HealthCheckResult> {
    console.log(`🏥 Pre-deployment health check for ${environment} environment\n`);

    const result: HealthCheckResult = {
        healthy: true,
        issues: [],
        actions: [],
        canProceed: true,
    };

    // Check CloudFormation health
    const stackIssues = await checkCloudFormationHealth(environment);

    // Check if any stack just completed a rollback
    const recentRollback = await checkForRecentRollback(environment);

    let ecsIssues: ECSIssue[] = [];

    // Skip ECS checks if requested and there was a recent rollback
    if (recentRollback && skipEcsAfterRollback) {
        console.log(`⚡ Skipping ECS health checks due to recent rollback and --skip-ecs-after-rollback flag`);
    } else {
        ecsIssues = await checkECSHealth(environment, recentRollback);
    }

    // Process CloudFormation issues
    for (const issue of stackIssues) {
        const message = `${issue.stackName}: ${issue.status} for ${Math.round(issue.stuckDurationMinutes)} minutes`;
        result.issues.push(message);
        result.healthy = false;

        if (issue.recommendedAction === 'cancel') {
            result.actions.push(`Cancel stuck operation: ${issue.stackName}`);

            if (autoFix) {
                console.log(`\n🛠️  Auto-fixing: Cancelling stuck operation for ${issue.stackName}`);
                const cancelled = await cancelStuckCloudFormationOperation(issue.stackName);

                if (cancelled) {
                    console.log(`⏳ Waiting for ${issue.stackName} to rollback...`);
                    const stable = await waitForStackStable(issue.stackName, 20);

                    if (stable) {
                        console.log(`✅ ${issue.stackName} has stabilized after cancellation`);
                        // Remove this issue from blocking deployment
                        result.issues = result.issues.filter((i) => !i.includes(issue.stackName));
                        result.actions = result.actions.filter((a) => !a.includes(issue.stackName));
                    } else {
                        result.canProceed = false;
                    }
                } else {
                    result.canProceed = false;
                }
            } else {
                result.canProceed = false;
            }
        } else if (issue.recommendedAction === 'wait') {
            result.actions.push(`Wait for operation to complete: ${issue.stackName}`);
            result.canProceed = false;
        }
    }

    // Process ECS issues with rollback consideration
    for (const issue of ecsIssues) {
        const message = `${issue.serviceName}: ${issue.issue}`;
        result.issues.push(message);
        result.healthy = false;

        if (issue.runningTasks === 0) {
            if (recentRollback && issue.issue.includes('starting up after rollback')) {
                // After rollback, allow some time for services to recover
                result.actions.push(`Info: Service ${issue.serviceName} is recovering from rollback`);
                // Don't block deployment for rollback recovery
            } else {
                result.actions.push(`Critical: Service ${issue.serviceName} is completely down`);
                result.canProceed = false; // Don't proceed if services are completely down
            }
        } else if (issue.deploymentStuckMinutes && issue.deploymentStuckMinutes > 10) {
            result.actions.push(`Consider force-updating service: ${issue.serviceName}`);
        }
    }

    // If we detected a recent rollback and have ECS recovery issues, wait and retry
    if (
        recentRollback &&
        ecsIssues.some((issue) => issue.runningTasks === 0 && issue.issue.includes('starting up after rollback'))
    ) {
        console.log(`\n⏳ Recent rollback detected. Waiting 2 minutes for ECS services to recover...`);
        await new Promise((resolve) => setTimeout(resolve, 120000)); // Wait 2 minutes

        console.log(`🔄 Re-checking ECS service health after recovery period...`);
        const retryEcsIssues = await checkECSHealth(environment, false); // Check without rollback leniency

        // Replace ECS issues with retry results
        const nonEcsIssues = result.issues.filter(
            (issue) => !ecsIssues.some((ecsIssue) => issue.includes(ecsIssue.serviceName)),
        );
        const nonEcsActions = result.actions.filter(
            (action) => !ecsIssues.some((ecsIssue) => action.includes(ecsIssue.serviceName)),
        );

        result.issues = nonEcsIssues;
        result.actions = nonEcsActions;

        // Process retry results
        for (const issue of retryEcsIssues) {
            const message = `${issue.serviceName}: ${issue.issue}`;
            result.issues.push(message);
            result.healthy = false;

            if (issue.runningTasks === 0) {
                result.actions.push(`Critical: Service ${issue.serviceName} failed to recover after rollback`);
                result.canProceed = false;
            } else if (issue.deploymentStuckMinutes && issue.deploymentStuckMinutes > 10) {
                result.actions.push(`Consider force-updating service: ${issue.serviceName}`);
            }
        }

        if (retryEcsIssues.length === 0) {
            console.log(`✅ All ECS services recovered successfully after rollback`);
            result.healthy = true;
            result.canProceed = true;
        }
    }

    return result;
}

async function main() {
    const rawEnvironment = process.env.ENVIRONMENT || process.argv[2] || 'development';
    const autoFix = process.argv.includes('--auto-fix') || process.env.AUTO_FIX === 'true';
    const skipEcsAfterRollback = process.argv.includes('--skip-ecs-after-rollback');

    // Normalize the environment name to match CDK stack naming
    const environment = normalizeEnvironmentName(rawEnvironment);

    console.log(`🎯 Environment: ${environment}`);
    console.log(`🛠️  Auto-fix: ${autoFix ? 'enabled' : 'disabled'}`);
    console.log(`⚡ Skip ECS checks after rollback: ${skipEcsAfterRollback ? 'enabled' : 'disabled'}\n`);

    try {
        const result = await performHealthCheck(environment, autoFix, skipEcsAfterRollback);

        console.log(`\n📊 Health Check Results:`);
        console.log(`🏥 Overall Health: ${result.healthy ? '✅ Healthy' : '❌ Issues Found'}`);
        console.log(`🚀 Can Proceed: ${result.canProceed ? '✅ Yes' : '❌ No'}`);

        if (result.issues.length > 0) {
            console.log(`\n⚠️  Issues Found:`);
            result.issues.forEach((issue) => console.log(`   - ${issue}`));
        }

        if (result.actions.length > 0) {
            console.log(`\n💡 Recommended Actions:`);
            result.actions.forEach((action) => console.log(`   - ${action}`));
        }

        if (result.canProceed) {
            console.log(`\n🎉 Pre-deployment health check passed! Safe to proceed with deployment.`);
            process.exit(0);
        } else {
            console.log(`\n🛑 Pre-deployment health check failed! Fix issues before deploying.`);
            if (!autoFix) {
                console.log(`\n💡 Tips:`);
                console.log(`   • Run with --auto-fix to automatically resolve some issues`);
                console.log(`   • Run with --skip-ecs-after-rollback to bypass ECS checks after rollbacks`);
                console.log(`   • Or use npm run health-check:fast for both options`);
            }
            process.exit(1);
        }
    } catch (error) {
        console.error(`💥 Health check failed:`, error);
        process.exit(1);
    }
}

main();
