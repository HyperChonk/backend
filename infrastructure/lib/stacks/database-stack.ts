import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/shared/types';
import { generateResourceName, SHARED_CONFIG } from '../../config/environments/shared';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface DatabaseStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
    vpc: ec2.IVpc;
    securityGroup: ec2.ISecurityGroup;
    backupsBucket: s3.IBucket;
    databaseSubnetGroup: rds.ISubnetGroup;
}

export class DatabaseStack extends cdk.Stack {
    public readonly database: rds.DatabaseInstance;
    public readonly databaseCredentials: rds.DatabaseSecret;
    public readonly exportRole: iam.Role;

    constructor(scope: Construct, id: string, props: DatabaseStackProps) {
        super(scope, id, props);

        const { config, vpc, securityGroup, backupsBucket, databaseSubnetGroup } = props;

        // Create database credentials
        this.databaseCredentials = new rds.DatabaseSecret(this, 'DatabaseCredentials', {
            secretName: generateResourceName('db-credentials', config.environment),
            username: 'postgres',
        });

        // Create IAM role for RDS data export to S3
        this.exportRole = new iam.Role(this, 'RDSExportRole', {
            roleName: generateResourceName('rds-export-role', config.environment),
            assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
            description: 'Role for RDS data export to S3 via aws_s3 extension',
            inlinePolicies: {
                RDSExportPolicy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: [
                                's3:PutObject*',
                                's3:GetObject*',
                                's3:ListBucket',
                                's3:DeleteObject*',
                                's3:GetBucketLocation',
                            ],
                            resources: [
                                backupsBucket.bucketArn,
                                `${backupsBucket.bucketArn}/*`, // Grant access to the bucket and objects within it
                            ],
                        }),
                    ],
                }),
            },
        });

        // Reconstruct instance type from config to ensure proper CDK object
        // This fixes the "db.[object Object]" issue by ensuring we have a proper InstanceType object
        const instanceType = config.database.instanceSize;

        // Create RDS instance with looked-up dependencies
        this.database = new rds.DatabaseInstance(this, 'Database', {
            instanceIdentifier: generateResourceName('database', config.environment),
            engine: rds.DatabaseInstanceEngine.postgres({
                version: config.database.engineVersion,
            }),
            instanceType: instanceType,
            credentials: rds.Credentials.fromSecret(this.databaseCredentials),
            databaseName: SHARED_CONFIG.database.name,
            vpc: vpc,
            subnetGroup: databaseSubnetGroup,
            securityGroups: [securityGroup],
            allocatedStorage: config.database.allocatedStorage,
            maxAllocatedStorage: config.database.maxAllocatedStorage,
            backupRetention: cdk.Duration.days(config.database.backupRetention),
            deleteAutomatedBackups: !config.database.deletionProtection,
            deletionProtection: config.database.deletionProtection,
            multiAz: config.database.multiAz,
            enablePerformanceInsights: config.database.performanceInsights,
            parameterGroup: new rds.ParameterGroup(this, 'ParameterGroup', {
                engine: rds.DatabaseInstanceEngine.postgres({
                    version: config.database.engineVersion,
                }),
                parameters: {
                    max_connections: config.database.connectionLimits.maxConnections.toString(),
                    shared_preload_libraries: 'pg_stat_statements',
                },
            }),
            s3ExportRole: this.exportRole,
        });

        // Apply tags
        Object.entries(config.tags).forEach(([key, value]) => {
            cdk.Tags.of(this.database).add(key, value);
        });

    }



}
