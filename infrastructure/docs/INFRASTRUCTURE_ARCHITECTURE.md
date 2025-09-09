# Infrastructure Architecture Documentation

## Overview

The Balancer V3 Backend infrastructure is designed as a multi-stack, multi-environment AWS CDK application that supports deploying completely new environments from scratch. The architecture follows AWS best practices for scalability, security, and maintainability.

## Design Principles

### 1. **Environment Isolation**
- Each environment (development, staging, production) is completely isolated
- Resources are deployed to separate AWS accounts or regions when needed
- Environment-specific configurations prevent cross-contamination

### 2. **Modular Stack Design**
- Infrastructure is split into logical, reusable stacks
- Each stack has a single responsibility (networking, security, compute, etc.)
- Stacks can be deployed independently (with dependency management)

### 3. **Cross-Stack Dependencies**
- **Decision**: Use CloudFormation cross-stack exports/imports instead of SSM Parameter Store
- **Rationale**: Provides explicit dependency management and works reliably for greenfield deployments
- **Trade-off**: Creates tight coupling between stacks, but ensures consistency and prevents deletion accidents

### 4. **Declarative Configuration**
- Environment-specific configurations are defined in TypeScript
- Configuration validation ensures consistency across environments
- Type safety prevents configuration drift

## Stack Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     APPLICATION LAYER                       │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │   Monitoring    │  │  Log Forwarder  │  │     WAF      │ │
│  │     Stack       │  │     Stack       │  │    Stack     │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                      COMPUTE LAYER                          │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │    Compute      │  │   Certificate   │  │   Database   │ │
│  │     Stack       │  │     Stack       │  │    Stack     │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                    INFRASTRUCTURE LAYER                     │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │   Networking    │  │    Security     │  │      S3      │ │
│  │     Stack       │  │     Stack       │  │    Stack     │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │      SQS        │  │    Secrets      │  │ Hosted Zone  │ │
│  │     Stack       │  │     Stack       │  │    Stack     │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Stack Details

### Infrastructure Layer

#### 1. Networking Stack (`networking-stack.ts`)
**Purpose**: Core networking infrastructure
**Resources**:
- VPC with public, private, and isolated subnets
- NAT Gateways (environment-dependent count)
- Internet Gateway
- Route Tables
- VPC Endpoints for AWS services
- Database Subnet Group

**Exports** (Cross-Stack):
- `${environment}-networking-vpc-id`
- `${environment}-networking-public-subnet-ids`
- `${environment}-networking-private-subnet-ids`
- `${environment}-networking-isolated-subnet-ids`
- `${environment}-networking-availability-zones`
- `${environment}-networking-db-subnet-group-name`

**Dependencies**: None (foundation stack)

#### 2. Security Stack (`security-stack.ts`)
**Purpose**: Security groups and IAM roles
**Resources**:
- ALB Security Group
- ECS Security Group
- Database Security Group
- VPC Endpoint Security Group

**Dependencies**: Networking Stack (imports VPC)

#### 3. S3 Stack (`s3-stack.ts`)
**Purpose**: Object storage for logs, assets, and backups
**Resources**:
- Logs Bucket
- Assets Bucket  
- Backups Bucket
- Lifecycle policies

**Dependencies**: None

#### 4. SQS Stack (`sqs-stack.ts`)
**Purpose**: Message queues for background processing
**Resources**:
- Background Job Queue
- Data Refresh Queue
- Notification Queue
- Dead Letter Queues
- KMS encryption keys

**Dependencies**: None

#### 5. Secrets Stack (`secrets-stack.ts`)
**Purpose**: AWS Secrets Manager for application configuration
**Resources**:
- Environment configuration secret
- Database credentials

**Dependencies**: None

#### 6. Hosted Zone Stack (`hosted-zone-stack.ts`)
**Purpose**: DNS management
**Resources**:
- Route53 Hosted Zone
- DNS records

**Dependencies**: None

### Compute Layer

#### 7. Database Stack (`database-stack.ts`)
**Purpose**: RDS PostgreSQL database
**Resources**:
- RDS Instance
- Database Parameter Group
- Automated backups
- Performance Insights (production)

**Dependencies**: Networking Stack, Security Stack

#### 8. Certificate Stack (`certificate-stack.ts`)
**Purpose**: SSL/TLS certificates
**Resources**:
- ACM Certificates
- DNS validation records

**Dependencies**: Hosted Zone Stack

#### 9. Compute Stack (`compute-stack.ts`)
**Purpose**: Application containers and load balancing
**Resources**:
- ECS Cluster
- ECS Services (API, Worker, Scheduler)
- Application Load Balancer
- Target Groups
- Task Definitions
- Auto Scaling configurations

**Dependencies**: Networking, Security, Database, Certificate, SQS, Secrets, S3

### Application Layer

#### 10. WAF Stack (`waf-stack.ts`)
**Purpose**: Web application firewall
**Resources**:
- WAF Web ACL
- Rate limiting rules
- Security rules

**Dependencies**: None

#### 11. Monitoring Stack (`monitoring-stack.ts`)
**Purpose**: Observability and alerting
**Resources**:
- CloudWatch Dashboards
- CloudWatch Alarms
- SNS Topics for alerts

**Dependencies**: Compute Stack

#### 12. Log Forwarder Stack (`log-forwarder-stack.ts`)
**Purpose**: Log aggregation and forwarding
**Resources**:
- Lambda function for log processing
- CloudWatch Log Groups

**Dependencies**: Compute Stack

## Cross-Stack Communication

### 1. CloudFormation Exports/Imports
**Used for**: Infrastructure resources (VPC, subnets, security groups)
**Benefits**:
- Explicit dependency management
- Atomic deployment/rollback
- Type safety at deployment time
- Prevents deletion of dependencies

**Format**:
```typescript
// Export (in networking stack)
new cdk.CfnOutput(this, 'VpcIdExport', {
  value: this.vpc.vpcId,
  exportName: `${environment}-networking-vpc-id`
});

// Import (in dependent stack)
const vpcId = cdk.Fn.importValue(`${environment}-networking-vpc-id`);
```

### 2. SSM Parameter Store
**Used for**: Dynamic application configuration
**Benefits**:
- Runtime parameter updates
- Loose coupling for configuration
- Hierarchical organization

**Usage**: Queue URLs, API keys, feature flags

## Deployment Strategy

### 1. Deployment Workflows

The infrastructure supports two deployment approaches:

#### **Full Deployment (deploy.yml)**
- **Purpose**: Complete infrastructure + application deployment
- **Use Cases**: Infrastructure changes, new environments
- **Process**: Uses CDK to deploy all stacks with specified image tag
- **Input**: Docker image tag (e.g., `latest`, `1.41.8-abc123def`)

#### **Code-Only Deployment (deploy-code.yml)**
- **Purpose**: Fast application updates without infrastructure changes
- **Use Cases**: Application code updates, configuration changes
- **Process**: Updates ECS services directly with new task definitions
- **Input**: Builds and pushes new Docker image automatically

### 2. Sequential Deployment
Stacks are deployed in dependency order:

1. **Foundation**: Networking, Security, S3, SQS, Secrets, Hosted Zone
2. **Infrastructure**: Database, Certificate, WAF  
3. **Application**: Compute
4. **Monitoring**: Monitoring, Log Forwarder

### 3. Environment Bootstrap
For completely new environments:
1. Deploy networking stack first
2. Cross-stack exports become available
3. Dependent stacks can reference exports reliably
4. No manual parameter management required

### 4. Rollback Safety
- CloudFormation manages rollback automatically
- Cross-stack dependencies prevent out-of-order deletion
- Database deletion protection for production
- Code-only deployments can rollback via ECS service updates

## Configuration Management

### Environment-Specific Configuration
Located in: `infrastructure/config/environments/`

- `development.ts` - Development environment settings
- `staging.ts` - Staging environment settings  
- `production.ts` - Production environment settings
- `shared.ts` - Common configuration utilities

### Configuration Validation
- TypeScript interfaces ensure configuration consistency
- Runtime validation prevents invalid deployments
- Environment-specific overrides for resource sizing

## Resource Naming Convention

All resources follow the pattern:
```
v3-backend-${environment}-${resource-type}
```

Examples:
- `v3-backend-staging-vpc`
- `v3-backend-production-alb`
- `v3-backend-development-cluster`

## Security Considerations

### 1. Network Security
- Private subnets for application containers
- Isolated subnets for databases
- Security groups with least-privilege access
- VPC endpoints to reduce internet traffic

### 2. Data Security
- Encryption at rest for all storage services
- KMS customer-managed keys
- Secrets Manager for sensitive configuration
- IAM roles with minimal permissions

### 3. Application Security
- WAF protection for production
- Container image scanning
- Security group isolation
- SSL/TLS termination at load balancer

## Monitoring and Observability

### 1. CloudWatch Integration
- Centralized logging via CloudWatch Logs
- Custom metrics and dashboards
- Automated alerting for critical events

### 2. Application Performance Monitoring
- ECS service metrics
- ALB performance metrics
- Database performance insights
- Custom application metrics

## Cost Optimization

### 1. Environment-Specific Sizing
- Development: Minimal resources (t3.micro, single NAT)
- Staging: Mid-tier resources for testing
- Production: Full redundancy and performance

### 2. Lifecycle Management
- S3 lifecycle policies for log retention
- CloudWatch log retention policies
- Database backup retention tuning

## Future Considerations

### 1. Multi-Region Support
- Current design supports single-region deployment
- Cross-stack exports are region-specific
- Future: Add region parameter to configuration

### 2. Blue/Green Deployments
- Current design supports rolling updates
- Future: Add blue/green deployment capability
- Requires additional ALB target groups

### 3. Service Mesh
- Current design uses direct service communication
- Future: Consider AWS App Mesh for microservices communication
- Would require additional networking configuration

## Troubleshooting Guide

### Common Issues

#### 1. Cross-Stack Import Failures
**Symptom**: `Export ${name} not found`
**Solution**: Ensure networking stack is deployed first
**Prevention**: Use deployment scripts that respect dependency order

#### 2. Resource Naming Conflicts
**Symptom**: `Resource already exists`
**Solution**: Check resource naming conventions
**Prevention**: Use consistent environment prefixes

#### 3. Subnet Configuration Issues
**Symptom**: `Subnet ID not valid`
**Solution**: Verify cross-stack exports are correct
**Note**: This was the original issue that led to the cross-stack refactor

## Documentation Updates

This document should be updated when:
- New stacks are added
- Cross-stack dependencies change
- Configuration structure changes
- Deployment procedures change

Last Updated: July 2025