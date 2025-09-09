#!/usr/bin/env ts-node

import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { normalizeEnvironmentName } from '../config/environments/shared';

const execAsync = promisify(exec);

interface DeploymentConfig {
    environment: string;
    imageUri: string;
    maxRetries: number;
    skipRecovery: boolean;
}

async function checkStackStatus(stackName: string): Promise<string> {
    try {
        const { stdout } = await execAsync(
            `aws cloudformation describe-stacks --stack-name ${stackName} --query 'Stacks[0].StackStatus' --output text`
        );
        return stdout.trim();
    } catch (error) {
        return 'STACK_NOT_FOUND';
    }
}

async function forceCleanupStack(stackName: string): Promise<boolean> {
    console.log(`🧹 Force cleaning stack: ${stackName}`);
    
    try {
        const status = await checkStackStatus(stackName);
        
        if (status.includes('ROLLBACK_FAILED')) {
            console.log(`🛠️  Stack in ROLLBACK_FAILED state, attempting continue-rollback...`);
            
            // Get failed resources
            const { stdout: eventsJson } = await execAsync(
                `aws cloudformation describe-stack-events --stack-name ${stackName} --query 'StackEvents[?ResourceStatus==\`CREATE_FAILED\` || ResourceStatus==\`UPDATE_FAILED\`][0:5].LogicalResourceId' --output json`
            );
            
            const failedResources = JSON.parse(eventsJson);
            console.log(`📋 Found ${failedResources.length} failed resources:`, failedResources);
            
            if (failedResources.length > 0) {
                const resourcesArg = failedResources.join(' ');
                await execAsync(
                    `aws cloudformation continue-update-rollback --stack-name ${stackName} --resources-to-skip ${resourcesArg}`
                );
                console.log(`✅ Initiated continue-rollback for ${stackName}`);
                
                // Wait for completion
                await execAsync(`aws cloudformation wait stack-rollback-complete --stack-name ${stackName}`, {
                    timeout: 20 * 60 * 1000 // 20 minutes
                });
                console.log(`✅ Rollback completed for ${stackName}`);
            }
        }
        
        return true;
    } catch (error: any) {
        console.error(`❌ Failed to cleanup ${stackName}:`, error.message);
        return false;
    }
}

async function deployStackWithRecovery(
    stackName: string, 
    config: DeploymentConfig,
    retryCount: number = 0
): Promise<boolean> {
    console.log(`🚀 Deploying stack: ${stackName} (attempt ${retryCount + 1}/${config.maxRetries + 1})`);

    try {
        const contextArgs = `--context environment=${config.environment} --context imageUri=${config.imageUri}`;
        const command = `npx cdk deploy ${stackName} --require-approval never ${contextArgs}`;

        const { stdout, stderr } = await execAsync(command, {
            cwd: join(__dirname, '..'),
            timeout: 25 * 60 * 1000, // 25 minute timeout per stack
        });

        console.log(`✅ Successfully deployed: ${stackName}`);
        return true;
        
    } catch (error: any) {
        console.error(`❌ Failed to deploy ${stackName} (attempt ${retryCount + 1}):`, error.message);
        
        // Check if it's a circuit breaker or rollback failure
        if (error.message.includes('Circuit Breaker') || error.message.includes('ROLLBACK_FAILED')) {
            if (!config.skipRecovery && retryCount < config.maxRetries) {
                console.log(`🔄 Attempting recovery for ${stackName}...`);
                
                const cleaned = await forceCleanupStack(stackName);
                if (cleaned) {
                    console.log(`🔄 Retrying deployment of ${stackName}...`);
                    return deployStackWithRecovery(stackName, config, retryCount + 1);
                }
            }
        }
        
        if (error.stdout) console.log('Stdout:', error.stdout.substring(0, 1500));
        if (error.stderr) console.log('Stderr:', error.stderr.substring(0, 1500));
        return false;
    }
}

async function deployWithRecovery() {
    const args = process.argv.slice(2);
    const environment = process.env.ENVIRONMENT || args.find((arg) => !arg.startsWith('--')) || 'development';
    const imageUri = process.env.IMAGE_URI || args.find((arg, index) => !arg.startsWith('--') && arg !== environment && index > 0);
    const maxRetries = parseInt(process.env.MAX_RETRIES || '2');
    const skipRecovery = process.env.SKIP_RECOVERY === 'true';

    const normalizedEnvironment = normalizeEnvironmentName(environment);

    if (!imageUri) {
        console.error(`❌ ERROR: IMAGE_URI is required but not provided!`);
        process.exit(1);
    }

    const config: DeploymentConfig = {
        environment: normalizedEnvironment,
        imageUri,
        maxRetries,
        skipRecovery
    };

    console.log(`🎯 Deploying to ${normalizedEnvironment} with recovery enabled`);
    console.log(`📦 Using image: ${imageUri}`);
    console.log(`🔄 Max retries: ${maxRetries}`);
    console.log(`🛠️  Recovery: ${skipRecovery ? 'disabled' : 'enabled'}`);

    // Deploy infrastructure stacks first (lower risk)
    const infraStacks = [
        `v3-backend-${normalizedEnvironment}-networking`,
        `v3-backend-${normalizedEnvironment}-security`,
        `v3-backend-${normalizedEnvironment}-s3`,
        `v3-backend-${normalizedEnvironment}-sqs`,
        `v3-backend-${normalizedEnvironment}-secrets`,
        `v3-backend-${normalizedEnvironment}-database`,
        `v3-backend-${normalizedEnvironment}-certificate`,
        `v3-backend-${normalizedEnvironment}-waf`,
    ];

    console.log(`\n📋 Phase 1: Infrastructure Stacks`);
    for (const stackName of infraStacks) {
        const success = await deployStackWithRecovery(stackName, { ...config, maxRetries: 1 }); // Less retries for infra
        if (!success) {
            console.error(`❌ Infrastructure deployment failed at: ${stackName}`);
            process.exit(1);
        }
    }

    // Deploy compute stack with more aggressive recovery
    console.log(`\n🚀 Phase 2: Application Stack (with recovery)`);
    const computeStack = `v3-backend-${normalizedEnvironment}-compute`;
    const success = await deployStackWithRecovery(computeStack, config);
    
    if (!success) {
        console.error(`❌ Application deployment failed: ${computeStack}`);
        console.log(`\n🛠️  Recovery options:`);
        console.log(`   1. Check application logs for specific errors`);
        console.log(`   2. Verify Docker image contains latest fixes`);
        console.log(`   3. Run with SKIP_RECOVERY=true to disable auto-recovery`);
        console.log(`   4. Manually clean up stack and retry`);
        process.exit(1);
    }

    // Deploy monitoring stacks last
    const monitoringStacks = [
        `v3-backend-${normalizedEnvironment}-monitoring`,
        `v3-backend-${normalizedEnvironment}-log-forwarder`,
    ];

    console.log(`\n📊 Phase 3: Monitoring Stacks`);
    for (const stackName of monitoringStacks) {
        const success = await deployStackWithRecovery(stackName, { ...config, maxRetries: 1 });
        if (!success) {
            console.log(`⚠️  Monitoring deployment failed: ${stackName} (non-critical)`);
        }
    }

    console.log(`\n🎉 Deployment completed successfully!`);
    console.log(`✅ Environment ${normalizedEnvironment} is ready`);
}

deployWithRecovery().catch((error) => {
    console.error('❌ Deployment failed:', error);
    process.exit(1);
});