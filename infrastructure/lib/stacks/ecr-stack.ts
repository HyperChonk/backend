import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface SharedECRStackProps extends cdk.StackProps {
    ecrRepositoryName: string;
    /**
     * AWS Account IDs that need access to this ECR repository
     * Include accounts for dev, staging, and production environments
     */
    crossAccountAccessPrincipals?: string[];
}

export class SharedECRStack extends cdk.Stack {
    public readonly repository: ecr.Repository;

    constructor(scope: Construct, id: string, props: SharedECRStackProps) {
        super(scope, id, props);

        const { ecrRepositoryName, crossAccountAccessPrincipals = [] } = props;

        // Create shared ECR Repository with lifecycle policy as JSON
        this.repository = new ecr.Repository(this, 'SharedECRRepository', {
            repositoryName: ecrRepositoryName,
            imageScanOnPush: true,
            imageTagMutability: ecr.TagMutability.MUTABLE,
            
            // Always retain shared repository (too critical to accidentally delete)
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // Add lifecycle policy using CfnRepository for more control
        const cfnRepository = this.repository.node.defaultChild as ecr.CfnRepository;
        cfnRepository.lifecyclePolicy = {
            lifecyclePolicyText: JSON.stringify({
                rules: [
                    {
                        rulePriority: 1,
                        description: 'Keep the last 25 production images (count-based)',
                        selection: {
                            tagStatus: 'tagged',
                            tagPrefixList: ['prod-'],
                            countType: 'imageCountMoreThan',
                            countNumber: 25
                        },
                        action: {
                            type: 'expire'
                        }
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep latest convenience tags for 14 days',
                        selection: {
                            tagStatus: 'tagged',
                            tagPrefixList: ['latest'],
                            countType: 'sinceImagePushed',
                            countUnit: 'days',
                            countNumber: 14
                        },
                        action: {
                            type: 'expire'
                        }
                    },
                    {
                        rulePriority: 3,
                        description: 'Keep the last 20 version-based images',
                        selection: {
                            tagStatus: 'tagged',
                            tagPrefixList: ['1.', '2.', '3.', '4.', '5.', '0.'],
                            countType: 'imageCountMoreThan',
                            countNumber: 20
                        },
                        action: {
                            type: 'expire'
                        }
                    },
                    {
                        rulePriority: 4,
                        description: 'Delete untagged images after 1 day',
                        selection: {
                            tagStatus: 'untagged',
                            countType: 'sinceImagePushed',
                            countUnit: 'days',
                            countNumber: 1
                        },
                        action: {
                            type: 'expire'
                        }
                    },
                    {
                        rulePriority: 5,
                        description: 'Clean up any remaining images after 90 days',
                        selection: {
                            tagStatus: 'any',
                            countType: 'sinceImagePushed',
                            countUnit: 'days',
                            countNumber: 90
                        },
                        action: {
                            type: 'expire'
                        }
                    }
                ]
            })
        };

        // Set up cross-account access if specified
        if (crossAccountAccessPrincipals.length > 0) {
            this.addCrossAccountAccess(crossAccountAccessPrincipals);
        }

        // Add tags for better resource management
        cdk.Tags.of(this.repository).add('Environment', 'shared');
        cdk.Tags.of(this.repository).add('Project', 'balancer-v3-backend');
        cdk.Tags.of(this.repository).add('Component', 'container-registry');
        cdk.Tags.of(this.repository).add('ManagedBy', 'CDK');
        cdk.Tags.of(this.repository).add('Shared', 'true');

        // Output repository details (without environment prefix since it's shared)
        new cdk.CfnOutput(this, 'ECRRepositoryName', {
            value: this.repository.repositoryName,
            description: 'Shared ECR Repository Name',
            exportName: `shared-ecr-repository-name`,
        });

        new cdk.CfnOutput(this, 'ECRRepositoryURI', {
            value: this.repository.repositoryUri,
            description: 'Shared ECR Repository URI',
            exportName: `shared-ecr-repository-uri`,
        });

        new cdk.CfnOutput(this, 'ECRRepositoryArn', {
            value: this.repository.repositoryArn,
            description: 'Shared ECR Repository ARN',
            exportName: `shared-ecr-repository-arn`,
        });
    }

    /**
     * Add cross-account access to the ECR repository
     */
    private addCrossAccountAccess(accountIds: string[]): void {
        const policyDocument = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    sid: 'CrossAccountECRAccess',
                    effect: iam.Effect.ALLOW,
                    principals: accountIds.map(accountId => new iam.AccountPrincipal(accountId)),
                    actions: [
                        'ecr:GetDownloadUrlForLayer',
                        'ecr:BatchGetImage',
                        'ecr:BatchCheckLayerAvailability',
                        'ecr:PutImage',
                        'ecr:InitiateLayerUpload',
                        'ecr:UploadLayerPart',
                        'ecr:CompleteLayerUpload',
                        'ecr:DescribeRepositories',
                        'ecr:GetRepositoryPolicy',
                        'ecr:ListImages',
                        'ecr:DescribeImages',
                        'ecr:BatchDeleteImage',
                        'ecr:GetLifecyclePolicy',
                        'ecr:GetLifecyclePolicyPreview',
                        'ecr:ListTagsForResource',
                        'ecr:DescribeImageScanFindings',
                    ],
                }),
            ],
        });

        // Apply the resource policy to the repository using CfnRepository
        const cfnRepository = this.repository.node.defaultChild as ecr.CfnRepository;
        cfnRepository.repositoryPolicyText = policyDocument;
    }

    /**
     * Grant necessary ECR permissions to a role or user
     */
    public grantECRPermissions(principal: iam.IPrincipal): void {
        // Grant comprehensive ECR permissions for CI/CD
        this.repository.grantPullPush(principal);
        
        // Additional permissions for lifecycle policy management and tagging
        principal.addToPrincipalPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ecr:GetLifecyclePolicy',
                'ecr:PutLifecyclePolicy',
                'ecr:DeleteLifecyclePolicy',
                'ecr:GetLifecyclePolicyPreview',
                'ecr:StartLifecyclePolicyPreview',
                'ecr:ListImages',
                'ecr:DescribeImages',
                'ecr:BatchDeleteImage',
                'ecr:BatchGetImage',
                'ecr:PutImage',
                'ecr:GetRepositoryPolicy',
                'ecr:DescribeRepositories',
            ],
            resources: [this.repository.repositoryArn],
        }));

        // Grant ECR token permissions (needed for docker login)
        principal.addToPrincipalPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ecr:GetAuthorizationToken',
            ],
            resources: ['*'], // GetAuthorizationToken requires wildcard resource
        }));
    }

    /**
     * Get repository metrics and monitoring setup
     */
    public addMonitoring(): void {
        // Add CloudWatch alarms for repository size and image count
        // This can be extended based on monitoring requirements
        
        // Tags for cost allocation
        cdk.Tags.of(this.repository).add('CostCenter', 'engineering');
        cdk.Tags.of(this.repository).add('Owner', 'backend-team');
    }
}