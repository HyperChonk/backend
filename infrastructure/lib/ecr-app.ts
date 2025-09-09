#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SharedECRStack } from './stacks/ecr-stack';

/**
 * Standalone ECR application for managing the shared container registry
 * This is deployed independently of environments and persists across environment lifecycle
 */
async function main() {
    const app = new cdk.App();

    // Get region from context or environment variable
    const region = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'us-east-1';

    console.log(`Deploying shared ECR repository to region: ${region}`);

    // Shared ECR Stack - completely independent of environments
    // This replicates the original functionality from deploy.yml where ECR was created separately
    const ecrStack = new SharedECRStack(app, 'balancer-v3-shared-ecr', {
        env: {
            account: process.env.CDK_DEFAULT_ACCOUNT,
            region: region,
        },
        ecrRepositoryName: 'balancer-api',
        // Add cross-account access if you have separate AWS accounts per environment
        // crossAccountAccessPrincipals: ['123456789012', '123456789013'], 
    });

    // Add global tags
    cdk.Tags.of(app).add('Project', 'BalancerV3Backend');
    cdk.Tags.of(app).add('Component', 'SharedECR');
    cdk.Tags.of(app).add('ManagedBy', 'CDK');
}

main().catch((error) => {
    console.error('Error initializing ECR CDK app:', error);
    process.exit(1);
});