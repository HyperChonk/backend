#!/usr/bin/env ts-node

import { SSMClient, PutParameterCommand, GetParameterCommand, AddTagsToResourceCommand } from '@aws-sdk/client-ssm';
import { ECRClient, DescribeImagesCommand } from '@aws-sdk/client-ecr';
import { normalizeEnvironmentName } from '../config/environments/shared';

const ssmClient = new SSMClient({ region: 'us-east-1' });
const ecrClient = new ECRClient({ region: 'us-east-1' });

interface PromotionRecord {
    imageTag: string;
    environment: string;
    promotedAt: string;
    promotedBy: string;
    sourceEnvironment?: string;
    deploymentId?: string;
    workflowRunId?: string;
    gitSha?: string;
}

interface ImageMetadata {
    tag: string;
    digest: string;
    pushedAt: Date;
    sizeInBytes: number;
}

export class PromotionTracker {
    constructor(private region: string = 'us-east-1') {}

    /**
     * Record an image promotion to an environment
     */
    async recordPromotion(record: PromotionRecord): Promise<void> {
        const parameterName = `/v3-backend/${record.environment}/promotions/${record.imageTag}`;

        try {
            // First, try to create/update the parameter without tags
            await ssmClient.send(
                new PutParameterCommand({
                    Name: parameterName,
                    Value: JSON.stringify(record),
                    Type: 'String',
                    Description: `Promotion record for ${record.imageTag} to ${record.environment}`,
                    Overwrite: true,
                }),
            );

            // Then add tags separately (only if this is a new parameter)
            try {
                const sanitizeTagValue = (value: string) =>
                    // Allow only AWS-SSM tag value charset: letters, spaces, numbers and _ . : / = + - @
                    value
                        .replace(/[^\p{L}\p{Z}\p{N}_.:\/=+\-@]/gu, '-')
                        .trim()
                        .slice(0, 256);

                const tags = [
                    { Key: 'Environment', Value: record.environment },
                    { Key: 'ImageTag', Value: record.imageTag },
                    { Key: 'PromotedBy', Value: record.promotedBy },
                    { Key: 'Type', Value: 'PromotionRecord' },
                ]
                    .map(({ Key, Value }) => ({ Key, Value: sanitizeTagValue(String(Value)) }))
                    .filter(({ Value }) => Value.length > 0);

                await ssmClient.send(
                    new AddTagsToResourceCommand({
                        ResourceType: 'Parameter',
                        ResourceId: parameterName,
                        Tags: tags,
                    }),
                );
            } catch (tagError) {
                // Tags are not critical, log but don't fail
                console.warn(`⚠️  Failed to add tags to parameter (non-critical):`, tagError);
            }

            // Also update the current image parameter
            await this.updateCurrentImage(record.environment, record.imageTag);

            console.log(`✅ Recorded promotion: ${record.imageTag} → ${record.environment}`);
        } catch (error) {
            console.error(`❌ Failed to record promotion:`, error);
            throw error;
        }
    }

    /**
     * Update the current deployed image for an environment
     */
    async updateCurrentImage(environment: string, imageTag: string): Promise<void> {
        const parameterName = `/v3-backend/${environment}/compute/currentImageTag`;

        try {
            // First, try to create/update the parameter without tags
            await ssmClient.send(
                new PutParameterCommand({
                    Name: parameterName,
                    Value: imageTag,
                    Type: 'String',
                    Description: `Current Docker image tag for ${environment}`,
                    Overwrite: true,
                }),
            );

            // Then add tags separately (only if this is a new parameter)
            try {
                const sanitizeTagValue = (value: string) =>
                    value
                        .replace(/[^\p{L}\p{Z}\p{N}_.:\/=+\-@]/gu, '-')
                        .trim()
                        .slice(0, 256);

                const tags = [
                    { Key: 'Environment', Value: environment },
                    { Key: 'Type', Value: 'CurrentImage' },
                ]
                    .map(({ Key, Value }) => ({ Key, Value: sanitizeTagValue(String(Value)) }))
                    .filter(({ Value }) => Value.length > 0);

                await ssmClient.send(
                    new AddTagsToResourceCommand({
                        ResourceType: 'Parameter',
                        ResourceId: parameterName,
                        Tags: tags,
                    }),
                );
            } catch (tagError) {
                // Tags are not critical, log but don't fail
                console.warn(`⚠️  Failed to add tags to parameter (non-critical):`, tagError);
            }

            console.log(`✅ Updated current image for ${environment}: ${imageTag}`);
        } catch (error) {
            console.error(`❌ Failed to update current image:`, error);
            throw error;
        }
    }

    /**
     * Get the current deployed image for an environment
     */
    async getCurrentImage(environment: string): Promise<string | null> {
        const parameterName = `/v3-backend/${environment}/compute/currentImageTag`;

        try {
            const response = await ssmClient.send(
                new GetParameterCommand({
                    Name: parameterName,
                }),
            );

            return response.Parameter?.Value || null;
        } catch (error: any) {
            if (error.name === 'ParameterNotFound') {
                return null;
            }
            throw error;
        }
    }

    /**
     * Get promotion history for an environment
     */
    async getPromotionHistory(environment: string): Promise<PromotionRecord[]> {
        // Note: This would require listing parameters by prefix, which is more complex
        // For now, we'll implement a simple version that gets the current promotion
        const currentImage = await this.getCurrentImage(environment);
        if (!currentImage) {
            return [];
        }

        try {
            const parameterName = `/v3-backend/${environment}/promotions/${currentImage}`;
            const response = await ssmClient.send(
                new GetParameterCommand({
                    Name: parameterName,
                }),
            );

            if (response.Parameter?.Value) {
                return [JSON.parse(response.Parameter.Value)];
            }
        } catch (error) {
            console.warn(`⚠️  No promotion record found for current image: ${currentImage}`);
        }

        return [];
    }

    /**
     * Validate that an image exists in ECR
     */
    async validateImageExists(imageTag: string, repository: string = 'balancer-api'): Promise<ImageMetadata | null> {
        try {
            const response = await ecrClient.send(
                new DescribeImagesCommand({
                    repositoryName: repository,
                    imageIds: [{ imageTag }],
                }),
            );

            const imageDetail = response.imageDetails?.[0];
            if (!imageDetail) {
                return null;
            }

            return {
                tag: imageTag,
                digest: imageDetail.imageDigest || '',
                pushedAt: imageDetail.imagePushedAt || new Date(),
                sizeInBytes: imageDetail.imageSizeInBytes || 0,
            };
        } catch (error) {
            console.error(`❌ Image not found: ${imageTag}`, error);
            return null;
        }
    }

    /**
     * Get deployment audit trail for an environment
     */
    async getDeploymentAudit(environment: string): Promise<{
        currentImage: string | null;
        promotionHistory: PromotionRecord[];
        imageMetadata: ImageMetadata | null;
    }> {
        const currentImage = await this.getCurrentImage(environment);
        const promotionHistory = await this.getPromotionHistory(environment);

        let imageMetadata: ImageMetadata | null = null;
        if (currentImage) {
            imageMetadata = await this.validateImageExists(currentImage);
        }

        return {
            currentImage,
            promotionHistory,
            imageMetadata,
        };
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    const tracker = new PromotionTracker();

    switch (command) {
        case 'record': {
            const environment = args[1];
            const imageTag = args[2];
            const promotedBy = args[3] || 'CLI';
            const sourceEnvironment = args[4];

            if (!environment || !imageTag) {
                console.error(
                    'Usage: promotion-tracker.ts record <environment> <imageTag> [promotedBy] [sourceEnvironment]',
                );
                process.exit(1);
            }

            await tracker.recordPromotion({
                imageTag,
                environment,
                promotedAt: new Date().toISOString(),
                promotedBy,
                sourceEnvironment,
            });
            break;
        }

        case 'current': {
            const environment = args[1];
            if (!environment) {
                console.error('Usage: promotion-tracker.ts current <environment>');
                process.exit(1);
            }

            // Normalize environment name - handle both 'dev' and 'development'
            const normalizedEnv = normalizeEnvironmentName(environment);
            const currentImage = await tracker.getCurrentImage(normalizedEnv);
            if (currentImage) {
                console.log(`Current image for ${environment}: ${currentImage}`);
            } else {
                console.log(`No current image recorded for ${environment}`);
            }
            break;
        }

        case 'audit': {
            const environment = args[1];
            if (!environment) {
                console.error('Usage: promotion-tracker.ts audit <environment>');
                process.exit(1);
            }

            // Normalize environment name - handle both 'dev' and 'development'
            const normalizedEnv = normalizeEnvironmentName(environment);
            const audit = await tracker.getDeploymentAudit(normalizedEnv);
            console.log('\n📋 Deployment Audit Report');
            console.log('============================');
            console.log(`Environment: ${environment}`);
            console.log(`Current Image: ${audit.currentImage || 'None'}`);

            if (audit.imageMetadata) {
                console.log(`Image Digest: ${audit.imageMetadata.digest.substring(0, 12)}...`);
                console.log(`Image Size: ${(audit.imageMetadata.sizeInBytes / 1024 / 1024).toFixed(2)} MB`);
                console.log(`Pushed At: ${audit.imageMetadata.pushedAt.toISOString()}`);
            }

            if (audit.promotionHistory.length > 0) {
                console.log('\n📈 Recent Promotions:');
                audit.promotionHistory.forEach((record, index) => {
                    console.log(`  ${index + 1}. ${record.imageTag} (${record.promotedAt}) by ${record.promotedBy}`);
                    if (record.sourceEnvironment) {
                        console.log(`     Promoted from: ${record.sourceEnvironment}`);
                    }
                });
            } else {
                console.log('\n📈 No promotion history available');
            }
            break;
        }

        case 'validate': {
            const imageTag = args[1];
            if (!imageTag) {
                console.error('Usage: promotion-tracker.ts validate <imageTag>');
                process.exit(1);
            }

            const metadata = await tracker.validateImageExists(imageTag);
            if (metadata) {
                console.log(`✅ Image exists: ${imageTag}`);
                console.log(`   Digest: ${metadata.digest.substring(0, 12)}...`);
                console.log(`   Size: ${(metadata.sizeInBytes / 1024 / 1024).toFixed(2)} MB`);
                console.log(`   Pushed: ${metadata.pushedAt.toISOString()}`);
            } else {
                console.log(`❌ Image not found: ${imageTag}`);
                process.exit(1);
            }
            break;
        }

        default:
            console.log('Usage: promotion-tracker.ts <command> [args...]');
            console.log('Commands:');
            console.log('  record <environment> <imageTag> [promotedBy] [sourceEnvironment]');
            console.log('  current <environment>');
            console.log('  audit <environment>');
            console.log('  validate <imageTag>');
            process.exit(1);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('Error:', error);
        process.exit(1);
    });
}
