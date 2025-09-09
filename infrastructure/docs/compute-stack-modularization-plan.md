# Compute Stack Modularization Plan

## Overview

This document outlines the plan to break down the monolithic compute stack into smaller, more manageable stacks while preserving the existing infrastructure-first deployment flow and all current functionality. The modularization will enhance deployment speed and maintainability without changing how the AWS infrastructure operates.

## Current Architecture

### Existing Stack Structure
The current deployment consists of these stacks (from `app.ts` and `deploy-sequential.ts`):

**Phase 1: Foundational Stacks**
- `networking-stack` - VPC, subnets, NAT gateway, VPC flow logs
- `security-stack` - Security groups for ALB, ECS, database, VPC endpoints

**Phase 2: Core Service Stacks**  
- `s3-stack` - S3 buckets for logs, assets, backups
- `sqs-stack` - SQS queues for background jobs, data refresh, notifications
- `secrets-stack` - AWS Secrets Manager configuration

**Phase 3: Data and Certificate Stacks**
- `hosted-zone-stack` - Route53 hosted zone (conditional, SSL-enabled environments)
- `database-stack` - RDS PostgreSQL instance and subnet group
- `certificate-stack` - SSL certificates with DNS validation (conditional)
- `waf-stack` - Web Application Firewall rules and IP sets

**Phase 4: Application Compute Stack** (MONOLITHIC - TO BE MODULARIZED)
- ECS Cluster and Services (API, Worker, Scheduler)
- Application Load Balancer (ALB) and Target Groups
- ALB Listeners (HTTP/HTTPS) and SSL certificate associations
- Task Definitions for all services
- IAM Roles (Execution and Task)
- CloudWatch Log Groups (API, Worker, Scheduler, Migration)
- Auto-scaling configurations
- Route53 DNS A records
- WAF associations
- SSM Parameters for cross-stack communication

**Phase 5: Post-Deployment Stacks**
- `monitoring-stack` - CloudWatch alarms, dashboards, SNS topics
- `log-forwarder-stack` - Lambda function for Grafana Cloud log forwarding

### Infrastructure-First Deployment Flow
The current system supports a sophisticated **infrastructure-first deployment pattern**:

**`--infra-only` Mode (Phases 1-3):**
- Deploys: VPC, security, storage, database, DNS, certificates
- Excludes: Application compute and monitoring
- Enables: Manual DNS configuration for certificate validation
- Use case: New environment setup where DNS needs manual configuration

**Full Deployment (Phases 1-5):**
- Deploys: Complete infrastructure including applications
- Use case: Updates to existing environments with validated certificates

## Target Architecture

The modularization splits the monolithic Phase 4 compute stack into three focused stacks while maintaining compatibility with the existing infrastructure-first deployment flow.

### Phase 4A: ALB Stack (Persistent Network Layer)
**Purpose**: Contains stable load balancing resources that rarely change

**Stack Name**: `v3-backend-{environment}-alb`

**Components**:
- Application Load Balancer (ALB)
- ALB Target Groups (API, Worker, Scheduler)
- ALB Listeners (HTTP/HTTPS with proper redirects)
- Route53 A Records pointing to ALB
- WAF Web ACL associations
- SSL certificate associations (references certificate-stack)
- ALB security group references (from security-stack)

**Benefits**:
- ALB DNS name remains stable across deployments
- Zero downtime for load balancing during application updates
- SSL certificates and WAF rules persist independently
- Enables blue/green deployment strategies

### Phase 4B: Shared Resources Stack (Semi-Persistent Layer) 
**Purpose**: Contains shared application resources used by multiple services

**Stack Name**: `v3-backend-{environment}-app-shared`

**Components**:
- IAM Task Execution Role (with ECR, Secrets Manager, CloudWatch permissions)
- IAM Task Role (with SQS, S3, database permissions)
- CloudWatch Log Groups (API, Worker, Scheduler, Migration)
- SSM Parameters for cross-stack resource sharing
- Common environment variables and configurations

**Benefits**:
- IAM roles persist across compute deployments (no permission downtime)
- CloudWatch log history is preserved during updates
- Centralized permission management
- Faster compute deployments (no IAM role updates)

### Phase 4C: Compute Stack (Frequently Updated Layer)
**Purpose**: Contains only the compute resources that change with code deployments

**Stack Name**: `v3-backend-{environment}-compute` (refactored)

**Components**:
- ECS Cluster
- ECS Task Definitions (API, Worker, Scheduler, Migration)
- ECS Services with target group attachments
- Auto-scaling policies and targets
- Service discovery configurations

**Benefits**:
- Ultra-fast updates (3-5 minutes vs 15-20 minutes currently)
- Minimal blast radius for application changes
- Easy rollback to previous task definitions
- No impact on networking or permissions during updates

### Updated Infrastructure-First Deployment Flow

**`--infra-only` Mode (Phases 1-4B):**
- ✅ **Includes**: ALB stack and shared resources for certificate validation
- ✅ **Excludes**: Phase 4C (compute) and Phase 5 (monitoring)
- ✅ **Enables**: Complete infrastructure setup including load balancer
- ✅ **Allows**: Manual DNS configuration between infrastructure and application

**Full Deployment (Phases 1-5):**
- ✅ **Includes**: All infrastructure plus applications and monitoring
- ✅ **Maintains**: Existing deployment workflow compatibility

## Implementation Steps

### Phase 1: Preparation
1. **Document Current Configuration**
   - [ ] Export all environment-specific secrets from Secrets Manager
   - [ ] Document all SSM parameters
   - [ ] Note current ALB DNS names
   - [ ] Save current security group rules
   - [ ] Document any manual configurations

2. **Create New Stack Structure**
   - [ ] Create `network-stack.ts` (for ALB and load balancing resources)
   - [ ] Create `shared-resources-stack.ts` (for IAM roles and log groups)
   - [ ] Refactor `compute-stack.ts` to only contain compute resources
   - [ ] Update `app.ts` to instantiate new stacks with proper dependencies
   - [ ] Update `deploy-sequential.ts` to include new stacks in deployment phases

### Phase 2: Stack Implementation

> **Note**: The existing `networking-stack.ts` handles VPC/subnets. The new `network-stack.ts` handles ALB and related network resources.

#### ALB Stack Implementation (NEW - lib/stacks/alb-stack.ts)
```typescript
// lib/stacks/alb-stack.ts
export interface AlbStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
    vpc: ec2.IVpc;
    albSecurityGroup: ec2.ISecurityGroup;
    certificate?: acm.ICertificate;
    wafWebAclArn?: string;
    hostedZone?: route53.IHostedZone;
}

export class AlbStack extends cdk.Stack {
    public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
    public readonly apiTargetGroup: elbv2.ApplicationTargetGroup;
    public readonly workerTargetGroup: elbv2.ApplicationTargetGroup;
    public readonly schedulerTargetGroup: elbv2.ApplicationTargetGroup;
    public readonly httpListener: elbv2.ApplicationListener;
    public readonly httpsListener?: elbv2.ApplicationListener;
    
    constructor(scope: Construct, id: string, props: AlbStackProps) {
        super(scope, id, props);
        
        // Create ALB with stable DNS name
        this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
            vpc: props.vpc,
            internetFacing: true,
            securityGroup: props.albSecurityGroup,
            // ... ALB configuration from current compute-stack.ts
        });
        
        // Create target groups for each service
        this.apiTargetGroup = new elbv2.ApplicationTargetGroup(/* ... */);
        this.workerTargetGroup = new elbv2.ApplicationTargetGroup(/* ... */);
        this.schedulerTargetGroup = new elbv2.ApplicationTargetGroup(/* ... */);
        
        // Create listeners with SSL certificate associations
        this.httpListener = this.loadBalancer.addListener(/* ... */);
        if (props.certificate) {
            this.httpsListener = this.loadBalancer.addListener(/* ... */);
        }
        
        // Associate WAF if provided
        if (props.wafWebAclArn) {
            // WAF association logic
        }
        
        // Create Route53 A records if hosted zone exists
        if (props.hostedZone && props.config.loadBalancer.ssl?.domainName) {
            new route53.ARecord(this, 'AliasRecord', {
                zone: props.hostedZone,
                recordName: props.config.loadBalancer.ssl.domainName,
                target: route53.RecordTarget.fromAlias(
                    new route53Targets.LoadBalancerTarget(this.loadBalancer)
                ),
            });
        }
        
        // Export critical values via SSM for cross-stack references
        new ssm.StringParameter(this, 'AlbArn', {
            parameterName: getSsmParameterName('alb', 'albArn', props.config.environment),
            stringValue: this.loadBalancer.loadBalancerArn,
        });
        
        new ssm.StringParameter(this, 'AlbDnsName', {
            parameterName: getSsmParameterName('alb', 'albDnsName', props.config.environment),
            stringValue: this.loadBalancer.loadBalancerDnsName,
        });
        
        // Export target group ARNs for compute stack
        new ssm.StringParameter(this, 'ApiTargetGroupArn', {
            parameterName: getSsmParameterName('alb', 'apiTargetGroupArn', props.config.environment),
            stringValue: this.apiTargetGroup.targetGroupArn,
        });
        
        // ... export other target group ARNs
    }
}
```

#### App Shared Resources Stack (NEW - lib/stacks/app-shared-stack.ts)
```typescript
// lib/stacks/app-shared-stack.ts
export interface AppSharedStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
    queues: {
        backgroundJobQueue: sqs.Queue;
        dataRefreshQueue: sqs.Queue;
        notificationQueue: sqs.Queue;
    };
    sqsEncryptionKeyArn: string;
    database: rds.DatabaseInstance; // Needed for DATABASE_URL construction
}

export class AppSharedStack extends cdk.Stack {
    public readonly taskExecutionRole: iam.Role;
    public readonly taskRole: iam.Role;
    public readonly apiLogGroup: logs.LogGroup;
    public readonly workerLogGroup: logs.LogGroup;
    public readonly schedulerLogGroup: logs.LogGroup;
    public readonly migrationLogGroup: logs.LogGroup;
    
    constructor(scope: Construct, id: string, props: AppSharedStackProps) {
        super(scope, id, props);
        
        // Create IAM roles with same permissions as current compute-stack.ts
        this.taskExecutionRole = new iam.Role(/* ... */);
        this.taskRole = new iam.Role(/* ... */);
        
        // Create CloudWatch log groups
        this.apiLogGroup = new logs.LogGroup(/* ... */);
        this.workerLogGroup = new logs.LogGroup(/* ... */);
        this.schedulerLogGroup = new logs.LogGroup(/* ... */);
        this.migrationLogGroup = new logs.LogGroup(/* ... */);
        
        // Export IAM role ARNs via SSM
        new ssm.StringParameter(this, 'TaskExecutionRoleArn', {
            parameterName: getSsmParameterName('app-shared', 'taskExecutionRoleArn', props.config.environment),
            stringValue: this.taskExecutionRole.roleArn,
        });
        
        new ssm.StringParameter(this, 'TaskRoleArn', {
            parameterName: getSsmParameterName('app-shared', 'taskRoleArn', props.config.environment),
            stringValue: this.taskRole.roleArn,
        });
        
        // Export log group names and ARNs for compute and log-forwarder stacks
        new ssm.StringParameter(this, 'ApiLogGroupName', {
            parameterName: getSsmParameterName('app-shared', 'apiLogGroupName', props.config.environment),
            stringValue: this.apiLogGroup.logGroupName,
        });
        
        new ssm.StringParameter(this, 'ApiLogGroupArn', {
            parameterName: getSsmParameterName('app-shared', 'apiLogGroupArn', props.config.environment),
            stringValue: this.apiLogGroup.logGroupArn,
        });
        
        // ... export other log group names and ARNs
    }
}
```

#### Refactored Compute Stack (lib/stacks/compute-stack.ts - MODIFIED)
```typescript
// lib/stacks/compute-stack.ts (refactored to use ALB and App-Shared stacks)
export interface ComputeStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
    vpc: ec2.IVpc;
    ecsSecurityGroup: ec2.ISecurityGroup;
    database: rds.DatabaseInstance;
    queues: {
        backgroundJobQueue: sqs.Queue;
        dataRefreshQueue: sqs.Queue;
        notificationQueue: sqs.Queue;
    };
    sqsEncryptionKeyArn: string;
    // Remove direct stack references after first deployment
    // Use SSM parameter lookups instead for better isolation
}

export class ComputeStack extends cdk.Stack {
    // Only ECS-specific resources remain
    public readonly cluster: ecs.Cluster;
    public readonly apiService: ecs.FargateService;
    public readonly workerService: ecs.FargateService;
    public readonly schedulerService: ecs.FargateService;
    
    constructor(scope: Construct, id: string, props: ComputeStackProps) {
        super(scope, id, props);
        
        // Look up ALB target groups from SSM parameters
        const apiTargetGroupArn = ssm.StringParameter.valueForStringParameter(
            this, getSsmParameterName('alb', 'apiTargetGroupArn', props.config.environment)
        );
        
        // Look up IAM roles from SSM parameters  
        const taskExecutionRoleArn = ssm.StringParameter.valueForStringParameter(
            this, getSsmParameterName('app-shared', 'taskExecutionRoleArn', props.config.environment)
        );
        
        const taskRoleArn = ssm.StringParameter.valueForStringParameter(
            this, getSsmParameterName('app-shared', 'taskRoleArn', props.config.environment)
        );
        
        // Look up log groups from SSM parameters
        const apiLogGroupName = ssm.StringParameter.valueForStringParameter(
            this, getSsmParameterName('app-shared', 'apiLogGroupName', props.config.environment)
        );
        
        // Create ECS cluster
        this.cluster = new ecs.Cluster(/* ... */);
        
        // Create task definitions using looked-up resources
        const apiTaskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDefinition', {
            family: generateResourceName('api-task', props.config.environment),
            executionRole: iam.Role.fromRoleArn(this, 'TaskExecutionRole', taskExecutionRoleArn),
            taskRole: iam.Role.fromRoleArn(this, 'TaskRole', taskRoleArn),
            // ... other configuration
        });
        
        // Create ECS services and attach to existing target groups
        this.apiService = new ecs.FargateService(this, 'ApiService', {
            cluster: this.cluster,
            taskDefinition: apiTaskDefinition,
            // ... service configuration
        });
        
        // Attach to existing target group (from ALB stack)
        const apiTargetGroup = elbv2.ApplicationTargetGroup.fromTargetGroupAttributes(
            this, 'ApiTargetGroup', { targetGroupArn: apiTargetGroupArn }
        );
        
        apiTargetGroup.addTarget(this.apiService);
        
        // ... create worker and scheduler services similarly
    }
}
```

#### Updated app.ts Integration
```typescript
// lib/app.ts (updated to include new stacks)
async function main() {
    const app = new cdk.App();
    const environmentName = normalizeEnvironmentName(/* ... */);
    const config = await loadEnvironmentConfig(environmentName);

    // ... existing foundation stacks (Phase 1-3) remain unchanged
    const networkingStack = new NetworkingStack(/* ... */);
    const securityStack = new SecurityStack(/* ... */);
    // ... s3Stack, sqsStack, secretsStack, databaseStack, wafStack
    
    // Conditional SSL stacks (existing)
    let hostedZoneStack: HostedZoneStack | undefined;
    let certificateStack: CertificateStack | undefined;
    
    if (config.loadBalancer.ssl?.enabled) {
        hostedZoneStack = new HostedZoneStack(/* ... */);
        certificateStack = new CertificateStack(/* ... */);
    }

    // NEW: ALB Stack (Phase 4A)
    const albStack = new AlbStack(app, generateStackName('alb', config.environment), {
        ...stackProps,
        vpc: networkingStack.vpc,
        albSecurityGroup: securityStack.securityGroups.albSecurityGroup,
        certificate: certificateStack?.certificate,
        wafWebAclArn: wafStack.webAcl?.attrArn,
        hostedZone: hostedZoneStack?.hostedZone,
    });

    // NEW: App Shared Resources Stack (Phase 4B)
    const appSharedStack = new AppSharedStack(app, generateStackName('app-shared', config.environment), {
        ...stackProps,
        queues: {
            backgroundJobQueue: sqsStack.backgroundJobQueue,
            dataRefreshQueue: sqsStack.dataRefreshQueue,
            notificationQueue: sqsStack.notificationQueue,
        },
        sqsEncryptionKeyArn: sqsStack.encryptionKey.keyArn,
        database: databaseStack.database,
    });

    // MODIFIED: Compute Stack (Phase 4C) - now much simpler
    const computeStack = new ComputeStack(app, generateStackName('compute', config.environment), {
        ...stackProps,
        vpc: networkingStack.vpc,
        ecsSecurityGroup: securityStack.securityGroups.ecsSecurityGroup,
        database: databaseStack.database,
        queues: {
            backgroundJobQueue: sqsStack.backgroundJobQueue,
            dataRefreshQueue: sqsStack.dataRefreshQueue,
            notificationQueue: sqsStack.notificationQueue,
        },
        sqsEncryptionKeyArn: sqsStack.encryptionKey.keyArn,
    });

    // Existing monitoring and log forwarder stacks (Phase 5) remain unchanged
    // but will need minor updates to use SSM lookups for log groups
    
    // Dependencies
    if (certificateStack) {
        albStack.addDependency(certificateStack);
    }
    if (hostedZoneStack) {
        albStack.addDependency(hostedZoneStack);
    }
    albStack.addDependency(wafStack);
    albStack.addDependency(securityStack);
    
    appSharedStack.addDependency(sqsStack);
    appSharedStack.addDependency(databaseStack);
    
    computeStack.addDependency(albStack);
    computeStack.addDependency(appSharedStack);
}
```

#### SSM Parameter Naming Convention
All SSM parameters use the existing `getSsmParameterName()` function:
```typescript
getSsmParameterName('alb', 'albArn', environment)
// Results in: /v3-backend/{environment}/alb/albArn

getSsmParameterName('app-shared', 'taskExecutionRoleArn', environment)  
// Results in: /v3-backend/{environment}/app-shared/taskExecutionRoleArn

getSsmParameterName('compute', 'currentImageTag', environment)
// Results in: /v3-backend/{environment}/compute/currentImageTag
```

Examples:
- `/v3-backend/development/alb/albArn`
- `/v3-backend/development/alb/apiTargetGroupArn`
- `/v3-backend/development/app-shared/taskExecutionRoleArn`
- `/v3-backend/development/app-shared/apiLogGroupName`
- `/v3-backend/development/compute/currentImageTag`

### Phase 3: Update Deployment Scripts

**Update deploy-sequential.ts** to include the new modularized stacks:

```typescript
const phases: DeploymentPhase[] = [
    {
        name: 'Phase 1: Foundational Stacks',
        description: 'Deploy networking and security first',
        stacks: [
            `v3-backend-${normalizedEnvironment}-networking`, 
            `v3-backend-${normalizedEnvironment}-security`
        ],
    },
    {
        name: 'Phase 2: Core Service Stacks',
        description: 'Deploy independent services',
        stacks: [
            `v3-backend-${normalizedEnvironment}-s3`,
            `v3-backend-${normalizedEnvironment}-sqs`,
            `v3-backend-${normalizedEnvironment}-secrets`,
        ],
    },
    {
        name: 'Phase 3: Data and Certificate Stacks',
        description: 'Deploy database, DNS, and certificates',
        stacks: [
            `v3-backend-${normalizedEnvironment}-hosted-zone`,
            `v3-backend-${normalizedEnvironment}-database`,
            `v3-backend-${normalizedEnvironment}-certificate`,
            `v3-backend-${normalizedEnvironment}-waf`,
        ],
    },
    {
        name: 'Phase 4A: Application Load Balancer Stack',    // NEW PHASE
        description: 'Deploy load balancing infrastructure',
        stacks: [`v3-backend-${normalizedEnvironment}-alb`],  // NEW STACK
    },
    {
        name: 'Phase 4B: Shared Application Resources Stack', // NEW PHASE
        description: 'Deploy shared IAM roles and log groups',
        stacks: [`v3-backend-${normalizedEnvironment}-app-shared`], // NEW STACK
    },
    {
        name: 'Phase 4C: Application Compute Stack',          // RENAMED
        description: 'Deploy ECS services and task definitions',
        stacks: [`v3-backend-${normalizedEnvironment}-compute`], // REFACTORED
    },
    {
        name: 'Phase 5: Post-Deployment Stacks',              // RENUMBERED
        description: 'Deploy monitoring and logging',
        stacks: [
            `v3-backend-${normalizedEnvironment}-monitoring`,
            `v3-backend-${normalizedEnvironment}-log-forwarder`,
        ],
    },
];

// Updated --infra-only mode filtering
if (infraOnly) {
    console.log(`🏗️  Skipping compute and monitoring stacks (infra-only mode)`);
    phasesToDeploy = phases.filter(phase => 
        !phase.name.includes('Phase 4C: Application Compute') && 
        !phase.name.includes('Phase 5: Post-Deployment')
    );
}
```

**Key Changes:**
- **Phase 4A (ALB)** and **Phase 4B (App-Shared)** are included in `--infra-only` mode
- **Phase 4C (Compute)** and **Phase 5 (Post-Deployment)** are excluded from `--infra-only` mode
- This preserves the infrastructure-first deployment capability

### Phase 4: Teardown (Per Environment)

**Automated Teardown** using existing force-delete-environment.yml workflow:
```bash
# Use the existing GitHub workflow (recommended)
# Workflow: "Force Delete Environment"
# Input: environment = "dev" | "staging" | "production"
# Input: confirm_environment_name = same environment name  
# Input: confirm_delete = "DELETE"
```

**Manual Teardown Order** (reverse dependency order):
1. `v3-backend-{env}-monitoring`
2. `v3-backend-{env}-log-forwarder`
3. `v3-backend-{env}-compute` (refactored)
4. `v3-backend-{env}-app-shared` (NEW)
5. `v3-backend-{env}-alb` (NEW)
6. `v3-backend-{env}-waf`
7. `v3-backend-{env}-certificate` (conditional)
8. `v3-backend-{env}-database`
9. `v3-backend-{env}-hosted-zone` (conditional)
10. `v3-backend-{env}-secrets`
11. `v3-backend-{env}-sqs`
12. `v3-backend-{env}-s3`
13. `v3-backend-{env}-security`
14. `v3-backend-{env}-networking`

**Manual Commands** (if needed):
```bash
# For each environment (dev, staging, production)
# Note: Use the environment-specific script names from package.json

npm run destroy:dev    # For development
npm run destroy:staging # For staging  
npm run destroy:prod   # For production

# Or individual stack destruction:
npx cdk destroy v3-backend-{env}-monitoring --context environment={env} --force
npx cdk destroy v3-backend-{env}-log-forwarder --context environment={env} --force
npx cdk destroy v3-backend-{env}-compute --context environment={env} --force
npx cdk destroy v3-backend-{env}-app-shared --context environment={env} --force
npx cdk destroy v3-backend-{env}-alb --context environment={env} --force
# ... continue in dependency order
```

### Phase 5: Recreation (Per Environment)

**Automated Recreation** using existing GitHub workflows:

**Option 1: Infrastructure-First Deployment (Recommended for new environments)**
```bash
# Step 1: Deploy infrastructure only
# Workflow: "Deploy Infrastructure"  
# Input: environment = "dev" | "staging" | "production"
# Input: image_tag = latest available tag
# Result: Deploys Phases 1-4B (includes ALB and shared resources)

# Step 2: Configure DNS manually at domain provider (if needed)
# Add CNAME records for certificate validation

# Step 3: Deploy full application
# Workflow: "Deploy Application"
# Input: environment = same environment  
# Result: Deploys Phase 4C (compute) and Phase 5 (monitoring)
```

**Option 2: Full Deployment (For environments with existing DNS)**
```bash
# Single deployment for all phases
# Workflow: "Deploy Application"
# Input: environment = "dev" | "staging" | "production"  
# Result: Deploys all phases 1-5 including new modularized stacks
```

**Manual Recreation Order** (dependency order):
1. `v3-backend-{env}-networking`
2. `v3-backend-{env}-security`
3. `v3-backend-{env}-s3`
4. `v3-backend-{env}-sqs`
5. `v3-backend-{env}-secrets`
6. `v3-backend-{env}-hosted-zone` (conditional)
7. `v3-backend-{env}-database`
8. `v3-backend-{env}-certificate` (conditional)
9. `v3-backend-{env}-waf`
10. `v3-backend-{env}-alb` (NEW)
11. `v3-backend-{env}-app-shared` (NEW)
12. `v3-backend-{env}-compute` (refactored)
13. `v3-backend-{env}-monitoring`
14. `v3-backend-{env}-log-forwarder`

**Manual Commands** (if needed):
```bash
# Use the existing deploy-sequential.ts script (will be updated)
cd infrastructure
npx ts-node scripts/deploy-sequential.ts development $IMAGE_TAG

# Or use environment-specific npm scripts:
npm run deploy:dev    # For development
npm run deploy:staging # For staging
npm run deploy:prod   # For production
```

### Phase 6: Verification

1. **Pre-Deployment Validation**
   - [ ] Run `cdk diff` to verify changes
   - [ ] Ensure all SSM parameters will be created
   - [ ] Validate cross-stack references
   - [ ] Check for circular dependencies

#### 2. IAM Role and `iam:PassRole` Permissions (Critical Update)
**Issue**: Separating IAM role creation into the `AppSharedStack` introduces a critical permission dependency. The CI/CD pipeline's deployment role (e.g., `GitHubActions-Deploy-Role`) executes `cdk deploy`. When the refactored `ComputeStack` is deployed, the AWS CloudFormation service, acting on behalf of the CI/CD role, must have permission to *pass* the IAM roles from the `AppSharedStack` to the new ECS services. Without this explicit permission, the `ComputeStack` deployment will fail with an IAM authorization error, even if all other configurations are correct.

**Recommendation**: The IAM policy for the CI/CD deployment role (`GitHubActions-Deploy-Role`) **must be updated**. It needs an explicit `iam:PassRole` statement that allows it to pass the newly created Task and Execution roles.

**Action Item**: Add the following statement to the `GitHubActions-Deploy-Role` IAM policy. This should be done *before* attempting to deploy the new modularized stacks.

```json
{
    "Sid": "AllowPassingECSRoles",
    "Effect": "Allow",
    "Action": "iam:PassRole",
    "Resource": [
        "arn:aws:iam::ACCOUNT_ID:role/v3-backend-*-task-execution-role",
        "arn:aws:iam::ACCOUNT_ID:role/v3-backend-*-task-role"
    ],
    "Condition": {
        "StringEquals": {
            "iam:PassedToService": "ecs-tasks.amazonaws.com"
        }
    }
}
```
> **Note**: Replace `ACCOUNT_ID` with your actual AWS Account ID. The wildcards (`*`) ensure this policy works for all environments (development, staging, production). This is a common and critical step that is often missed in stack modularization.

3. **Service Health Checks**
   - [ ] Verify ALB is healthy
   - [ ] Check all ECS services are running
   - [ ] Confirm target groups have healthy targets
   - [ ] Test API endpoints

3. **Resource Verification**
   - [ ] Confirm all log groups are created
   - [ ] Verify IAM roles have correct permissions
   - [ ] Check SSM parameters are populated correctly:
     - `/v3-backend/{env}/network/*` parameters
     - `/v3-backend/{env}/shared/*` parameters
     - `/v3-backend/{env}/compute/*` parameters
   - [ ] Validate auto-scaling is configured

4. **Connectivity Tests**
   - [ ] Test database connectivity
   - [ ] Verify SQS queue access
   - [ ] Confirm S3 bucket permissions
   - [ ] Check external API access
   - [ ] Validate DATABASE_URL is properly constructed in containers

## Benefits Summary

1. **Deployment Speed**: Compute-only updates drop from ~15 minutes to ~5 minutes
2. **Risk Reduction**: Network resources remain stable during compute updates
3. **Cost Optimization**: Can update compute resources without ALB downtime
4. **Developer Experience**: Faster iteration cycles for application changes
5. **Operational Clarity**: Clear separation of concerns between infrastructure layers

## Rollback Strategy

If issues arise during recreation:
1. Stop the deployment process
2. Identify the problematic stack
3. Fix the issue in code
4. Resume deployment from the last successful stack

Since environments aren't live, there's no risk to production traffic.

## Future Considerations

1. **Blue/Green Deployments**: With separated stacks, implementing blue/green becomes easier
2. **Multi-Region**: Network stack can be replicated for multi-region deployments
3. **Service Mesh**: Easier to add service mesh capabilities to just the compute layer
4. **Cost Allocation**: Better cost tracking per layer of infrastructure

## Timeline Estimate

- **Phase 1 (Preparation)**: 2-4 hours
- **Phase 2 (Implementation)**: 4-6 hours
- **Phase 3-4 (Teardown/Recreation per env)**: 1 hour per environment
- **Phase 5 (Verification)**: 1 hour per environment

**Total**: ~1-2 days for all environments

## Important Implementation Notes

### Infrastructure-First Deployment Compatibility
The modularization **preserves and enhances** the existing infrastructure-first deployment pattern:

**`--infra-only` Mode After Modularization:**
- ✅ **Includes:** Phases 1-4B (networking, security, services, databases, certificates, ALB, shared resources)
- ❌ **Excludes:** Phase 4C (compute) and Phase 5 (monitoring, log-forwarder)
- 🎯 **Result:** Complete load balancer infrastructure available for certificate validation
- 🔧 **Use Case:** New environments where DNS needs manual configuration

### Database URL Construction
The DATABASE_URL environment variable needs special handling:
- Currently constructed in compute-stack.ts using CloudFormation intrinsic functions
- App-Shared Resources Stack will need the database instance reference to construct this
- SSM parameter will store the constructed DATABASE_URL for compute stack lookup
- No functional change to how containers receive the DATABASE_URL

### Cross-Stack Dependencies and Migration Strategy
1. **Phase 1 - Initial Deployment with Direct References**: 
   - Use direct stack references in app.ts (as shown in implementation section)
   - This ensures clean deployment without SSM parameter timing issues
   - All stacks deploy successfully with proper dependencies

2. **Phase 2 - Switch to SSM Parameter Lookups** (optional optimization):
   - After successful initial deployment, compute stack can be updated to use SSM lookups
   - This provides better isolation between stacks for independent updates
   - Monitoring stack already uses SSM lookups (good example to follow)

3. **Log Forwarder Stack Updates**:
   - Currently uses direct log group references from compute stack
   - After modularization, update to use SSM parameter lookups:
     ```typescript
     const apiLogGroupArn = ssm.StringParameter.valueForStringParameter(
         this, getSsmParameterName('app-shared', 'apiLogGroupArn', config.environment)
     );
     ```

### GitHub Workflow Compatibility
The existing GitHub workflows will continue to work seamlessly:

**"Deploy Infrastructure" workflow (`deploy-infra.yml`):**
- Uses `deploy:dev:infra`, `deploy:staging:infra`, `deploy:prod:infra` scripts
- These scripts use the `--infra-only` flag in `deploy-sequential.ts`
- After modularization: Will deploy through Phase 4B (including ALB and shared resources)
- Result: Complete infrastructure ready for DNS configuration and certificate validation

**"Deploy Application" workflow (`deploy.yml`):**
- Deploys all phases including applications
- After modularization: Will deploy all phases including the new modularized stacks
- No changes needed to workflow files

### Validation Steps
Before starting the teardown:
1. Export all current configurations using existing scripts
2. Use the existing `force-delete-environment.yml` workflow for clean teardown
3. Save current ALB DNS names (they will change during recreation)
4. Document any manual Route53 entries or DNS configurations
5. Backup critical CloudWatch logs if needed

### Rollback Plan
If issues arise during recreation:
1. Keep the original `compute-stack.ts` as backup (`compute-stack.ts.backup`)
2. Can quickly revert by updating `app.ts` to use the original compute stack
3. Redeploy the monolithic version using existing deployment scripts
4. The existing infrastructure (Phases 1-3) remains unchanged as fallback

### Zero Downtime Strategy
Since environments can be completely recreated:
1. ALB DNS names will change, but this is acceptable for development/staging
2. For production: Consider blue/green approach using Route53 weighted routing
3. The modularization enables future blue/green deployments by keeping ALB stable

## Summary of Changes

### What This Modularization Achieves
1. **Faster Deployments**: Compute-only updates: 15+ minutes → 3-5 minutes
2. **Stable Load Balancer**: ALB DNS remains consistent, SSL certificates persist
3. **Preserved Infrastructure-First Flow**: `--infra-only` mode enhanced with ALB infrastructure
4. **Better Separation of Concerns**: Network, shared resources, and compute clearly separated
5. **Enhanced Rollback Capability**: Can rollback compute without affecting load balancer
6. **Future Blue/Green Enablement**: Infrastructure in place for zero-downtime deployments

### What Stays the Same
1. **All AWS Infrastructure Functionality**: No changes to how resources operate
2. **GitHub Workflows**: Existing deployment workflows continue to work
3. **Environment Configurations**: No changes to environment configs or secrets
4. **Database and Networking**: VPC, RDS, security groups unchanged
5. **Application Code**: No changes needed to application containers
6. **SSL and DNS**: Certificate validation process unchanged

### Implementation Priority
This modularization is **optional optimization** that can be implemented when:
- Development velocity would benefit from faster deployment times
- Team wants to enable blue/green deployment capabilities  
- Current monolithic compute stack becomes a bottleneck

### Next Steps
1. **Review and approve** this updated plan with team
2. **Schedule recreation window** for development environment first
3. **Implement modularization** following the phases outlined
4. **Validate functionality** and performance improvements
5. **Apply to staging and production** environments

## Notes

- ✅ **Plan updated** to reflect current codebase and infrastructure-first deployment flow
- ✅ **GitHub workflows compatibility** confirmed - no changes needed
- ✅ **Hosted zone stack** properly included in dependencies
- ✅ **Stack naming conflicts** resolved (ALB stack vs Networking stack)
- ✅ **SSM parameter patterns** aligned with existing `getSsmParameterName()` function
- 🔧 **Force-delete-environment.yml workflow** already handles proper deletion order for all stacks