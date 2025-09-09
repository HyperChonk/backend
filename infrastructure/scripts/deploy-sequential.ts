#!/usr/bin/env ts-node

import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { normalizeEnvironmentName, loadEnvironmentConfig } from '../config/environments/shared';
import { trackInfrastructureVersion } from './track-infrastructure-version';

const execAsync = promisify(exec);

interface DeploymentPhase {
    name: string;
    stacks: string[];
    description: string;
    parallel?: boolean; // New: indicates if stacks in this phase can be deployed in parallel
}

async function deployStack(
    stackName: string,
    environment: string,
    imageUri: string,
    dryRun: boolean = false,
    forceRecreate: boolean = false,
): Promise<boolean> {
    console.log(`🚀 Deploying stack: ${stackName}`);

    if (dryRun) {
        console.log(`🔍 Dry run: Would deploy ${stackName} with image ${imageUri}`);
        return true;
    }

    // Special handling for conditional stacks (like hosted-zone)
    const isHostedZoneStack = stackName.includes('-hosted-zone');
    if (isHostedZoneStack) {
        console.log(`⚠️  Note: Hosted zone stack is conditional based on SSL configuration`);
    }

    // Support both imageUri (backwards compatibility) and imageTag (new approach)
    let contextArgs = `--context environment=${environment}`;

    // Pass infra-only flag to CDK context for monitoring stack
    const isInfraOnly = process.argv.includes('--infra-only');
    if (isInfraOnly) {
        contextArgs += ` --context infraOnly=true`;
    }

    // Check if imageUri parameter contains a full URI or just a tag
    if (imageUri.includes('ecr') && imageUri.includes(':')) {
        // Full ECR URI provided - use as imageUri for backwards compatibility
        contextArgs += ` --context imageUri=${imageUri}`;
    } else {
        // Just tag provided - use as imageTag (preferred new format)
        contextArgs += ` --context imageTag=${imageUri}`;
    }

    // Add additional context from command line if provided
    const additionalContext = [];
    const args = process.argv.slice(2);

    // Parse --context arguments properly
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--context' && i + 1 < args.length) {
            const contextValue = args[i + 1];
            if (contextValue && contextValue.includes('=')) {
                additionalContext.push(`--context ${contextValue}`);
            }
            i++; // Skip the next argument since we consumed it
        } else if (arg.startsWith('--context=')) {
            const contextValue = arg.substring(10); // Remove '--context=' prefix
            if (contextValue && contextValue.includes('=')) {
                additionalContext.push(`--context ${contextValue}`);
            }
        }
    }

    // Add valid context arguments
    if (additionalContext.length > 0) {
        contextArgs += ` ${additionalContext.join(' ')}`;
    }

    // Use unique output directory for parallel deployments to avoid conflicts
    const outputDir = `cdk.out.${stackName.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const command = `npx cdk deploy ${stackName} --require-approval never --no-notices --output ${outputDir} ${contextArgs}`;

    try {
        // Special handling for certificate stack in all environments
        const isCertificateStack = stackName.includes('-certificate');

        if (isCertificateStack) {
            // Use shorter timeout for certificate stack (all environments)
            const { stdout, stderr } = await execAsync(command, {
                cwd: join(__dirname, '..'),
                timeout: 5 * 60 * 1000, // 5 minute timeout for certificate stack
            });
        } else {
            const { stdout, stderr } = await execAsync(command, {
                cwd: join(__dirname, '..'),
                timeout: 15 * 60 * 1000, // 15 minute timeout per stack
            });
        }

        console.log(`✅ Successfully deployed: ${stackName}`);
        return true;
    } catch (error: any) {
        // Special handling for certificate validation timeouts in all environments
        const isCertificateStack = stackName.includes('-certificate');
        const isHostedZoneStack = stackName.includes('-hosted-zone');

        if (isCertificateStack && error.message.includes('timeout')) {
            console.warn(`⚠️  Certificate stack deployment timed out (expected when DNS not yet configured)`);
            console.warn(`   The certificate will be in PENDING_VALIDATION state`);
            console.warn(`   Please manually configure DNS records to complete validation`);
            console.warn(`   Deployment will continue without certificate validation`);
            console.warn(`   Run 'npm run get-cert-validation:${environment}' for DNS configuration help`);
            return true; // Continue deployment despite certificate timeout
        }

        // Special handling for conditional stacks that might not be created due to config
        const isWafStack = stackName.includes('-waf');
        if ((isHostedZoneStack || isCertificateStack || isWafStack) && error.message.includes('No stacks match')) {
            console.warn(`⚠️  ${stackName} is conditional and may not be created based on environment configuration`);
            console.warn(`   This is expected if SSL is disabled or domain not configured`);
            return true; // Continue deployment despite conditional stack absence
        }

        // Handle SSM parameter conflicts (or force recreate if requested)
        if (
            (error.message.includes('already exists') && error.message.includes('AWS::SSM::Parameter')) ||
            forceRecreate
        ) {
            if (forceRecreate) {
                console.warn(`🔄 Force recreate requested for ${stackName}`);
            } else {
                console.warn(`⚠️  SSM parameter conflict detected for ${stackName}`);
                console.warn(`   This typically happens when redeploying compute stacks`);
            }
            console.warn(`   Attempting to delete and recreate the stack...`);

            try {
                // Try to delete the stack first
                const deleteCommand = `npx cdk destroy ${stackName} --force --no-notices`;
                await execAsync(deleteCommand, {
                    cwd: join(__dirname, '..'),
                    timeout: 10 * 60 * 1000, // 10 minute timeout for deletion
                });

                console.log(`🗑️  Successfully deleted ${stackName}, retrying deployment...`);

                // Retry the original deployment command
                const retryCommand = `npx cdk deploy ${stackName} --require-approval never --no-notices --output ${outputDir} ${contextArgs}`;
                await execAsync(retryCommand, {
                    cwd: join(__dirname, '..'),
                    timeout: 15 * 60 * 1000,
                });

                console.log(`✅ Successfully deployed: ${stackName} (after recreation)`);
                return true;
            } catch (retryError: any) {
                console.error(`❌ Failed to recreate ${stackName} after deletion:`, retryError.message);
                if (retryError.stdout) console.log('Retry Stdout:', retryError.stdout.substring(0, 1500));
                if (retryError.stderr) console.log('Retry Stderr:', retryError.stderr.substring(0, 1500));
                return false;
            }
        }

        console.error(`❌ Failed to deploy ${stackName}:`, error.message);
        if (error.stdout) console.log('Stdout:', error.stdout.substring(0, 1500));
        if (error.stderr) console.log('Stderr:', error.stderr.substring(0, 1500));
        return false;
    }
}

async function deployParallelGroup(
    stacks: string[],
    environment: string,
    imageUri: string,
    dryRun: boolean = false,
    forceRecreate: boolean = false,
): Promise<boolean> {
    console.log(`🔄 Deploying ${stacks.length} stacks in parallel: ${stacks.join(', ')}`);

    if (dryRun) {
        console.log(`🔍 Dry run: Would deploy ${stacks.length} stacks in parallel`);
        return true;
    }

    try {
        const startTime = Date.now();

        // Deploy all stacks in parallel using Promise.all
        const deploymentPromises = stacks.map((stackName, index) => {
            console.log(`   🚀 [${index + 1}/${stacks.length}] Starting parallel deployment: ${stackName}`);
            return deployStack(stackName, environment, imageUri, dryRun, forceRecreate);
        });

        console.log(`⏳ Waiting for ${stacks.length} parallel deployments to complete...`);
        const results = await Promise.all(deploymentPromises);

        const endTime = Date.now();
        const durationMinutes = Math.round((endTime - startTime) / 60000);

        // Check if all deployments succeeded
        const allSucceeded = results.every((result) => result === true);
        const successCount = results.filter((result) => result === true).length;
        const failureCount = results.length - successCount;

        if (allSucceeded) {
            console.log(
                `✅ All ${stacks.length} parallel deployments completed successfully in ${durationMinutes} minutes`,
            );
            console.log(`   📊 Success rate: ${successCount}/${stacks.length} (100%)`);
            return true;
        } else {
            console.error(`❌ Parallel deployment failed: ${failureCount}/${stacks.length} stacks failed`);
            console.error(
                `   📊 Success rate: ${successCount}/${stacks.length} (${Math.round(
                    (successCount / stacks.length) * 100,
                )}%)`,
            );

            // Log which stacks failed and succeeded
            results.forEach((result, index) => {
                if (result) {
                    console.log(`   ✅ Succeeded: ${stacks[index]}`);
                } else {
                    console.error(`   ❌ Failed: ${stacks[index]}`);
                }
            });
            return false;
        }
    } catch (error: any) {
        console.error(`❌ Parallel deployment group failed with unexpected error:`, error.message);
        if (error.stack) {
            console.error(`   Stack trace: ${error.stack.substring(0, 500)}...`);
        }
        return false;
    }
}

async function deployPhase(
    phase: DeploymentPhase,
    environment: string,
    imageUri: string,
    dryRun: boolean = false,
    enableParallel: boolean = false,
    forceRecreate: boolean = false,
): Promise<boolean> {
    console.log(`\n🚀 ${phase.name}: ${phase.description}`);

    // Check if this phase can and should be deployed in parallel
    if (phase.parallel && enableParallel && phase.stacks.length > 1) {
        console.log(`⚡ Parallel deployment enabled for this phase`);
        return await deployParallelGroup(phase.stacks, environment, imageUri, dryRun, forceRecreate);
    } else {
        // Use existing sequential deployment
        if (phase.parallel && enableParallel) {
            console.log(
                `ℹ️  Phase marked as parallel but only has ${phase.stacks.length} stack(s), deploying sequentially`,
            );
        }

        for (const stackName of phase.stacks) {
            const success = await deployStack(stackName, environment, imageUri, dryRun, forceRecreate);
            if (!success) {
                console.error(`❌ Phase failed at stack: ${stackName}`);
                return false;
            }
        }
    }

    console.log(`✅ ${phase.name} completed successfully`);
    return true;
}

async function main() {
    const args = process.argv.slice(2);
    const environment = process.env.ENVIRONMENT || args.find((arg) => !arg.startsWith('--')) || 'development';
    const imageUri =
        process.env.IMAGE_URI || args.find((arg, index) => !arg.startsWith('--') && arg !== environment && index > 0);

    // Parse command line flags
    const infraOnly = args.includes('--infra-only');
    const dryRun = args.includes('--dry-run');
    const enableParallel = args.includes('--parallel');
    const forceRecreate = args.includes('--force-recreate');

    // Normalize the environment name to match CDK stack naming
    const normalizedEnvironment = normalizeEnvironmentName(environment);

    if (!imageUri) {
        console.error(`❌ ERROR: IMAGE_URI is required but not provided!`);
        console.error(`   Set IMAGE_URI environment variable or pass as argument`);
        process.exit(1);
    }

    console.log(`🎯 Deploying to ${normalizedEnvironment} environment`);
    console.log(`📦 Using image: ${imageUri}`);
    if (infraOnly) {
        console.log(`🏗️  Infrastructure-only deployment mode enabled`);
    }
    if (dryRun) {
        console.log(`🔍 Dry run mode enabled - will not actually deploy`);
    }
    if (enableParallel) {
        console.log(`⚡ Parallel deployment mode enabled for compatible phases`);
    }
    if (forceRecreate) {
        console.log(`🔄 Force recreate mode enabled - will delete and recreate stacks with conflicts`);
    }

    // Load config so we can include conditional stacks (e.g., WAF) appropriately
    const config = await loadEnvironmentConfig(normalizedEnvironment);

    // Define deployment phases based on logical dependencies
    const phases: DeploymentPhase[] = [
        {
            name: 'Phase 1: Foundational Stacks',
            description: 'Deploy networking and security first',
            stacks: [`v3-backend-${normalizedEnvironment}-networking`, `v3-backend-${normalizedEnvironment}-security`],
        },
        {
            name: 'Phase 2: Core Service Stacks',
            description: 'Deploy independent services',
            parallel: true, // Safe to deploy in parallel - no dependencies between s3, sqs, secrets
            stacks: [
                `v3-backend-${normalizedEnvironment}-s3`,
                `v3-backend-${normalizedEnvironment}-sqs`,
                `v3-backend-${normalizedEnvironment}-secrets`,
            ],
        },
        {
            name: 'Phase 3: Data and Certificate Stacks',
            description: 'Deploy database and certificates',
            stacks: [
                `v3-backend-${normalizedEnvironment}-hosted-zone`,
                `v3-backend-${normalizedEnvironment}-database`,
                `v3-backend-${normalizedEnvironment}-certificate`,
                // Include WAF only when enabled for this environment
                ...(config.security.enableWaf ? [`v3-backend-${normalizedEnvironment}-waf`] : []),
            ],
        },
        {
            name: 'Phase 4: Application Compute Stack',
            description: 'Deploy the application services',
            stacks: [`v3-backend-${normalizedEnvironment}-compute`],
        },
        {
            name: 'Phase 5: Post-Deployment Stacks',
            description: 'Deploy monitoring and logging',
            stacks: [
                `v3-backend-${normalizedEnvironment}-monitoring`,
                `v3-backend-${normalizedEnvironment}-log-forwarder`,
            ],
        },
    ];

    // Filter phases based on deployment mode
    let phasesToDeploy = phases;
    if (infraOnly) {
        console.log(`🏗️  Infrastructure-only deployment mode enabled`);
        console.log(`🏗️  Skipping application and monitoring stacks (infra-only mode)`);
        phasesToDeploy = phases.filter(
            (phase) => !phase.name.includes('Application Compute') && !phase.name.includes('Post-Deployment'),
        );
    }

    // Deploy each phase sequentially
    for (const phase of phasesToDeploy) {
        const success = await deployPhase(
            phase,
            normalizedEnvironment,
            imageUri,
            dryRun,
            enableParallel,
            forceRecreate,
        );
        if (!success) {
            console.error(`💥 Deployment failed during ${phase.name}`);
            process.exit(1);
        }
    }

    console.log(`\n🎉 All phases deployed successfully!`);

    // Track infrastructure version after successful deployment
    if (!dryRun) {
        console.log(`\n📝 Recording infrastructure deployment version...`);
        try {
            await trackInfrastructureVersion(normalizedEnvironment);
            console.log(`✅ Infrastructure version recorded successfully`);
        } catch (error) {
            console.warn(`⚠️ Failed to record infrastructure version:`, error);
            console.warn(`⚠️ This does not affect the deployment success`);
        }
    }

    console.log(`✅ Sequential deployment completed for ${normalizedEnvironment} environment`);
    process.exit(0);
}

main().catch((error) => {
    console.error('Error during sequential deployment:', error);
    process.exit(1);
});
