import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/shared/types';
import { generateResourceName, getSsmParameterName } from '../../config/environments/shared';

export interface NetworkingStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
}

/**
 * Networking Stack for Balancer v3 Backend
 *
 * Creates VPC, subnets, gateways, and basic networking infrastructure
 * with environment-specific configuration and security best practices.
 */
export class NetworkingStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly publicSubnets: ec2.ISubnet[];
    public readonly privateSubnets: ec2.ISubnet[];
    public readonly databaseSubnetGroup: rds.SubnetGroup;
    public flowLogGroup?: logs.LogGroup;

    constructor(scope: Construct, id: string, props: NetworkingStackProps) {
        super(scope, id, props);

        const { config } = props;

        // Create VPC with environment-specific CIDR
        this.vpc = new ec2.Vpc(this, 'VPC', {
            vpcName: generateResourceName('vpc', config.environment),
            ipAddresses: ec2.IpAddresses.cidr(this.getCidrForEnvironment(config.environment)),
            maxAzs: 2, // Use 2 AZs for high availability
            enableDnsHostnames: true,
            enableDnsSupport: true,

            // Configure subnets
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'PublicSubnet',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'PrivateSubnet',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
                {
                    cidrMask: 26,
                    name: 'DatabaseSubnet',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],

            // Configure NAT Gateway based on environment
            natGateways: config.environment === 'production' ? 2 : 1,

            // Flow logs configuration - simplified for now
            flowLogs: this.createFlowLogsConfig(config),
        });

        // Store subnet references
        this.publicSubnets = this.vpc.publicSubnets;
        this.privateSubnets = this.vpc.privateSubnets;

        // Create database subnet group for RDS
        this.databaseSubnetGroup = new rds.SubnetGroup(this, 'DatabaseSubnetGroup', {
            description: `Database subnet group for ${config.environment} environment`,
            vpc: this.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            subnetGroupName: generateResourceName('db-subnet-group', config.environment),
        });

        // Add VPC endpoints for cost optimization and security
        this.addVpcEndpoints(config);

        // Export networking configuration to SSM parameters for migration script
        this.createSsmOutputs(config);

        // Apply tags to all VPC resources
        this.applyTags(config);
    }

    /**
     * Create flow logs configuration with proper log group and retention
     */
    private createFlowLogsConfig(config: EnvironmentConfig): { [key: string]: ec2.FlowLogOptions } | undefined {
        if (!config.security.enableFlowLogs) {
            return undefined;
        }

        // Create dedicated log group for VPC flow logs
        const flowLogGroup = new logs.LogGroup(this, 'VPCFlowLogsGroup', {
            logGroupName: `/aws/vpc/flowlogs/v3-backend-${config.environment}`,
            retention: config.environment === 'production' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        // Expose the log group for use by other stacks
        this.flowLogGroup = flowLogGroup;

        // Create IAM role for flow logs
        const flowLogRole = new iam.Role(this, 'VPCFlowLogRole', {
            assumedBy: new iam.ServicePrincipal('vpc-flow-logs.amazonaws.com'),
            inlinePolicies: {
                FlowLogDeliveryPolicy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: [
                                'logs:CreateLogGroup',
                                'logs:CreateLogStream',
                                'logs:PutLogEvents',
                                'logs:DescribeLogGroups',
                                'logs:DescribeLogStreams',
                            ],
                            resources: [flowLogGroup.logGroupArn, `${flowLogGroup.logGroupArn}:*`],
                        }),
                    ],
                }),
            },
        });

        return {
            cloudWatch: {
                destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup, flowLogRole),
                trafficType: ec2.FlowLogTrafficType.ALL,
            },
        };
    }

    /**
     * Get CIDR block based on environment to ensure no overlap
     */
    private getCidrForEnvironment(environment: string): string {
        switch (environment) {
            case 'development':
                return '10.0.0.0/16';
            case 'staging':
                return '10.1.0.0/16';
            case 'production':
                return '10.2.0.0/16';
            default:
                return '10.0.0.0/16';
        }
    }

    /**
     * Add VPC endpoints for AWS services to reduce NAT Gateway costs
     */
    private addVpcEndpoints(config: EnvironmentConfig): void {
        // S3 Gateway endpoint (free)
        this.vpc.addGatewayEndpoint('S3Endpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
            subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
        });

        // DynamoDB Gateway endpoint (free)
        this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
            service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
            subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
        });

        // Add interface endpoints for production environment
        if (config.environment === 'production') {
            // ECR endpoints for container registry access
            this.vpc.addInterfaceEndpoint('ECREndpoint', {
                service: ec2.InterfaceVpcEndpointAwsService.ECR,
                subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            });

            this.vpc.addInterfaceEndpoint('ECRDockerEndpoint', {
                service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
                subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            });

            // CloudWatch logs endpoint
            this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
                service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
                subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            });

            // Secrets Manager endpoint
            this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
                service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
                subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            });

            // SQS endpoint
            this.vpc.addInterfaceEndpoint('SQSEndpoint', {
                service: ec2.InterfaceVpcEndpointAwsService.SQS,
                subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            });
        }
    }

    /**
     * Export networking configuration to SSM parameters for migration script
     */
    private createSsmOutputs(config: EnvironmentConfig): void {
        new ssm.StringParameter(this, 'PrivateSubnetIds', {
            parameterName: getSsmParameterName('networking', 'privateSubnetIds', config.environment),
            stringValue: this.privateSubnets.map((subnet) => subnet.subnetId).join(','),
            description: `Private subnet IDs for ${config.environment} environment`,
            tier: ssm.ParameterTier.STANDARD,
        });
    }

    /**
     * Apply consistent tags to all resources
     */
    private applyTags(config: EnvironmentConfig): void {
        // Apply environment-specific tags
        Object.entries(config.tags).forEach(([key, value]) => {
            cdk.Tags.of(this.vpc).add(key, value);
        });

        // Apply additional networking-specific tags
        cdk.Tags.of(this.vpc).add('Stack', 'Networking');
        cdk.Tags.of(this.vpc).add('Component', 'VPC');

        // Add a unique tag for Vpc.fromLookup
        cdk.Tags.of(this.vpc).add('ApplicationVPC', generateResourceName('vpc', config.environment));
    }
}
