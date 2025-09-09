import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/shared/types';
import { generateResourceName } from '../../config/environments/shared';

export interface SecurityGroupsProps {
    vpc: ec2.IVpc;
    config: EnvironmentConfig;
}

/**
 * Security Groups Construct for Balancer v3 Backend
 *
 * Creates security groups with least-privilege access patterns for:
 * - Application Load Balancer
 * - ECS containers (API and background jobs)
 * - RDS database
 * - General outbound access
 */
export class SecurityGroups extends Construct {
    public readonly albSecurityGroup: ec2.SecurityGroup;
    public readonly ecsSecurityGroup: ec2.SecurityGroup;
    public readonly databaseSecurityGroup: ec2.SecurityGroup;
    public readonly vpcEndpointSecurityGroup: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props: SecurityGroupsProps) {
        super(scope, id);

        const { vpc, config } = props;

        // Create ALB Security Group
        this.albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
            vpc,
            securityGroupName: generateResourceName('alb-sg', config.environment),
            description: 'Security group for Application Load Balancer',
            allowAllOutbound: false,
        });

        // Create ECS Security Group
        this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
            vpc,
            securityGroupName: generateResourceName('ecs-sg', config.environment),
            description: 'Security group for ECS containers',
            allowAllOutbound: false,
        });

        // Create Database Security Group
        this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
            vpc,
            securityGroupName: generateResourceName('db-sg', config.environment),
            description: 'Security group for RDS database',
            allowAllOutbound: false,
        });

        // Create VPC Endpoint Security Group
        this.vpcEndpointSecurityGroup = new ec2.SecurityGroup(this, 'VPCEndpointSecurityGroup', {
            vpc,
            securityGroupName: generateResourceName('vpce-sg', config.environment),
            description: 'Security group for VPC endpoints',
            allowAllOutbound: false,
        });

        // Configure security group rules
        this.configureAlbRules();
        this.configureEcsRules();
        this.configureDatabaseRules();
        this.configureVpcEndpointRules();

        // Apply tags
        this.applyTags(config);
    }

    /**
     * Configure ALB security group rules
     */
    private configureAlbRules(): void {
        // Allow HTTP inbound from internet
        this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from internet');

        // Allow HTTPS inbound from internet
        this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from internet');

        // Allow outbound to ECS containers on application port (covers health checks as well)
        this.albSecurityGroup.addEgressRule(
            this.ecsSecurityGroup,
            ec2.Port.tcp(4000),
            'Allow outbound to ECS containers',
        );
    }

    /**
     * Configure ECS security group rules
     */
    private configureEcsRules(): void {
        // Allow inbound from ALB on application port
        this.ecsSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(4000), 'Allow inbound from ALB');

        // Allow outbound HTTPS for external API calls and package downloads
        this.ecsSecurityGroup.addEgressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),
            'Allow HTTPS outbound for external APIs',
        );

        // Allow outbound HTTP for external API calls
        this.ecsSecurityGroup.addEgressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(80),
            'Allow HTTP outbound for external APIs',
        );

        // Allow outbound to database
        this.ecsSecurityGroup.addEgressRule(
            this.databaseSecurityGroup,
            ec2.Port.tcp(5432),
            'Allow outbound to PostgreSQL database',
        );

        // Allow outbound to VPC endpoints
        this.ecsSecurityGroup.addEgressRule(
            this.vpcEndpointSecurityGroup,
            ec2.Port.tcp(443),
            'Allow outbound to VPC endpoints',
        );

        // Allow outbound for SQS (HTTPS to AWS SQS service)
        this.ecsSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow outbound to SQS service');

        // Allow outbound DNS queries
        this.ecsSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(53), 'Allow outbound DNS TCP');

        this.ecsSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), 'Allow outbound DNS UDP');

        // Allow outbound NTP for time synchronization
        this.ecsSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(123), 'Allow outbound NTP');
    }

    /**
     * Configure database security group rules
     */
    private configureDatabaseRules(): void {
        // Allow inbound from ECS containers on PostgreSQL port
        this.databaseSecurityGroup.addIngressRule(
            this.ecsSecurityGroup,
            ec2.Port.tcp(5432),
            'Allow inbound from ECS containers',
        );

        // No outbound rules needed for database (RDS manages this)
    }

    /**
     * Configure VPC endpoint security group rules
     */
    private configureVpcEndpointRules(): void {
        // Allow inbound HTTPS from ECS containers
        this.vpcEndpointSecurityGroup.addIngressRule(
            this.ecsSecurityGroup,
            ec2.Port.tcp(443),
            'Allow HTTPS from ECS containers',
        );

        // No outbound rules needed (endpoints are managed by AWS)
    }

    /**
     * Apply consistent tags to all security groups
     */
    private applyTags(config: EnvironmentConfig): void {
        const securityGroups = [
            this.albSecurityGroup,
            this.ecsSecurityGroup,
            this.databaseSecurityGroup,
            this.vpcEndpointSecurityGroup,
        ];

        securityGroups.forEach((sg) => {
            Object.entries(config.tags).forEach(([key, value]) => {
                cdk.Tags.of(sg).add(key, value);
            });
            cdk.Tags.of(sg).add('Component', 'SecurityGroup');
        });
    }

    /**
     * Get security group by service type
     */
    public getSecurityGroupByService(service: 'alb' | 'ecs' | 'database' | 'vpce'): ec2.SecurityGroup {
        switch (service) {
            case 'alb':
                return this.albSecurityGroup;
            case 'ecs':
                return this.ecsSecurityGroup;
            case 'database':
                return this.databaseSecurityGroup;
            case 'vpce':
                return this.vpcEndpointSecurityGroup;
            default:
                throw new Error(`Unknown service type: ${service}`);
        }
    }

    /**
     * Allow additional ingress rule to ECS from custom source
     */
    public allowIngressToEcs(peer: ec2.IPeer, port: ec2.Port, description: string): void {
        this.ecsSecurityGroup.addIngressRule(peer, port, description);
    }

    /**
     * Allow additional egress rule from ECS to custom destination
     */
    public allowEgressFromEcs(peer: ec2.IPeer, port: ec2.Port, description: string): void {
        this.ecsSecurityGroup.addEgressRule(peer, port, description);
    }
}
