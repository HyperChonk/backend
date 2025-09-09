# Balancer V3 Backend Infrastructure

This directory contains the AWS infrastructure code for the Balancer GraphQL API using AWS CDK (TypeScript).

## ✨ Key Features

-   🤖 **AI-Optimized Monitoring**: YAML output format (80% more token-efficient for LLM analysis)
-   🔒 **SSL Certificate Management**: Automated validation, expiration tracking, domain-aware health checks
-   🌐 **Domain-Aware Operations**: Environment-specific URL generation eliminates certificate mismatches
-   📊 **21+ Component Validation**: Comprehensive infrastructure health monitoring
-   🔄 **Enhanced CI/CD Pipeline**: Intelligent retry logic with comprehensive validation
-   🎯 **Environment Compliance**: Automatic dev/staging/production configuration validation

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           GitHub Actions CI/CD                      │
├─────────────────────────────────────────────────────────────────────┤
│  develop → Dev Environment    │  staging → Staging     │  main → Prod │
│  (Automatic)                  │  (Automatic)           │  (Manual)    │
└───────────┬───────────────────────────┬─────────────────────┬─────┘
              │                           │                     │
              ▼                           ▼                     ▼
    ┌─────────────────┐         ┌─────────────────┐   ┌─────────────────┐
    │   Dev Stack     │         │ Staging Stack   │   │  Prod Stack     │
    │                 │         │                 │   │                 │
    │ • VPC           │         │ • VPC           │   │ • VPC           │
    │ • RDS (t3.micro)│         │ • RDS (t3.small)│   │ • RDS (t3.medium)│
    │ • ECS (0.25 CPU)│         │ • ECS (0.5 CPU) │   │ • ECS (1 CPU)   │
    │ • ALB           │         │ • ALB           │   │ • ALB           │
    │ • SQS           │         │ • SQS           │   │ • SQS           │
    │ • ECR (shared)  │         │ • Secrets Mgr   │   │ • Monitoring    │
    └─────────────────┘         └─────────────────┘   └─────────────────┘
```

## 🔄 CI/CD Flow Explanation

### **Deployment Workflows**

The infrastructure uses two GitHub Actions workflows for different deployment scenarios:

#### **1. Full Deployment (deploy.yml)**

-   **Purpose**: Complete infrastructure + application deployment
-   **Input**: Docker image tag (e.g., `latest`, `1.41.8-abc123def`)
-   **Use Cases**: Infrastructure changes, new environments, full deployments
-   **Trigger**: Manual via GitHub Actions UI

#### **2. Code-Only Deployment (deploy-code.yml)**

-   **Purpose**: Fast application updates without infrastructure changes
-   **Input**: Uses latest Docker images from ECR
-   **Use Cases**: Application code updates, configuration changes
-   **Trigger**: Can be configured for automatic branch deployments

#### **Code Changes & Triggers**

```bash
# Development workflow
git checkout develop
git add .
git commit -m "feat: new feature"
git push origin develop
# → Can trigger automatic code-only deployment to DEV (if configured)

# Staging workflow
git checkout staging
git merge develop
git push origin staging
# → Can trigger automatic code-only deployment to STAGING (if configured)

# Production workflow
git checkout main
git merge staging
git push origin main
# → Manual deployment to PRODUCTION via GitHub UI (full or code-only)
```

#### 2. **Deployment Workflow Steps**

**Full Deployment (deploy.yml):**

```mermaid
graph TD
    A[Manual Trigger] --> B[Validate Input Image Tag]
    B --> C[Configure AWS]
    C --> D[Deploy Infrastructure with Image]
    D --> E[Run DB Migrations]
    E --> F[Domain-Aware Health Checks]
    F --> G[Infrastructure Validation]
    G --> H[Success ✅]
```

**Code-Only Deployment (deploy-code.yml):**

```mermaid
graph TD
    A[Code Push/Manual] --> B[Checkout & Setup]
    B --> C[Install Dependencies]
    C --> D[Generate Prisma Client]
    D --> E[Run Tests]
    E --> F[Build Application]
    F --> G[Configure AWS]
    G --> H[Build & Push Docker Image]
    H --> I[Update ECS Services]
    I --> J[Run DB Migrations]
    J --> K[Health Checks]
    K --> L[Success ✅]
```

#### 3. **Docker Image Management**

**Code-Only Deployment:**

```bash
# 1. Build optimized image with Bun
docker build --build-arg NODE_ENV=production -t app:latest .

# 2. Push to ECR with multiple tags
docker push ECR_REGISTRY/balancer-api:$GITHUB_SHA           # Specific commit
docker push ECR_REGISTRY/balancer-api:dev-latest            # Environment latest
docker push ECR_REGISTRY/balancer-api:release-20241220      # Release tag
```

**Full Deployment:**

```bash
# Use pre-built image tag from ECR
# No building required - validates image exists and deploys it
echo "Using image: ECR_REGISTRY/balancer-api:$IMAGE_TAG"
```

#### 4. **AWS Infrastructure Updates**

**Full Deployment:**

```bash
# CDK deploys complete infrastructure with specified image
npx cdk deploy v3-backend-dev-compute \
  --context imageTag=$IMAGE_TAG \
  --context environment=development

# Updates entire infrastructure stack if needed
```

**Code-Only Deployment:**

```bash
# Updates ECS service with new image directly
aws ecs update-service \
  --cluster v3-backend-dev-cluster \
  --service v3-backend-dev-api-service \
  --task-definition new-task-def

# ECS rolling deployment
# → Old containers gradually replaced with new ones
# → Zero downtime via ALB health checks
```

#### 5. **Database Migrations**

```bash
# Runs as a separate ECS task
aws ecs run-task \
  --cluster balancer-dev-cluster \
  --task-definition balancer-dev-migration-task \
  --overrides '{"containerOverrides":[{
    "name":"balancer-api",
    "command":["sh","-c","./scripts/init-secrets.sh && npx prisma migrate deploy"]
  }]}'
```

#### 6. **Domain-Aware Health Checks & Validation**

```bash
# Enhanced deployment validation using environment-specific domains
# Eliminates SSL certificate mismatch issues

# 1. Get environment-specific URL
HEALTH_URL=$(node scripts/get-environment-config.js $ENVIRONMENT)
# Returns: https://dev-api.hyperchonk.com for development
#          https://staging-api.hyperchonk.com for staging
#          https://api.hyperchonk.com for production

# 2. Comprehensive infrastructure validation
npm run check-status:$ENVIRONMENT

# 3. Domain-aware health check with retry logic
curl -f "$HEALTH_URL/health" --retry 6 --retry-delay 10

# 4. SSL certificate validation
curl -f "$HEALTH_URL/health" --ssl-reqd --cert-status
```

### **Environment-Specific Behaviors**

| Environment    | Trigger        | Approval | Tests              | DB Backup | Monitoring |
| -------------- | -------------- | -------- | ------------------ | --------- | ---------- |
| **Dev**        | Auto (develop) | None     | Unit               | None      | Basic      |
| **Staging**    | Auto (staging) | None     | Unit + Integration | None      | Enhanced   |
| **Production** | Manual (main)  | Required | All + Security     | Yes       | Full       |

## 🚀 Initial Setup

### **1. Prerequisites**

```bash
# Required tools
node --version    # v18+
npm --version     # v8+
aws --version     # v2+

# AWS CLI configuration
aws configure
# Enter your AWS credentials
```

### **2. Infrastructure Setup**

```bash
# 1. Install infrastructure dependencies
cd infrastructure
npm install

# 2. Bootstrap CDK (one-time per AWS account/region)
npx cdk bootstrap

# 3. Deploy infrastructure (two-step process for new environments)
# For NEW environments, you must deploy the networking stack first:

# Development environment (first deployment)
npx cdk deploy v3-backend-development-networking
npx cdk deploy --all --context environment=development

# Staging environment (first deployment)
npx cdk deploy v3-backend-staging-networking
npx cdk deploy --all --context environment=staging

# Production environment (first deployment)
npx cdk deploy v3-backend-production-networking
npx cdk deploy --all --context environment=production

# 4. Subsequent deployments (after initial setup)
# After the first deployment, you can deploy all stacks together:
npm run deploy:dev      # Development environment
npm run deploy:staging  # Staging environment
npm run deploy:prod     # Production environment
```

#### **Why Two-Step Deployment?**

The two-step deployment process is required for **new environments** when using VPC lookups for cross-stack dependencies:

1. **Step 1 - Networking Stack**: Establishes VPC and networking resources
2. **Step 2 - All Stacks**: Dependent stacks can reference the networking resources through direct construct passing

**Benefits:**

-   ✅ Establishes clear dependency hierarchy between stacks
-   ✅ Enables proper resource referencing without SSM parameter lookups
-   ✅ Allows CDK to automatically manage dependencies through construct passing
-   ✅ Simplifies cross-stack communication and reduces coupling

**Note:** This is only required for the **initial deployment** of a new environment. After the networking stack is deployed, subsequent deployments can reference the constructs directly.

### **3. Secrets Configuration**

Create environment-specific secrets in AWS Secrets Manager:

```bash
# Create secrets for each environment
aws secretsmanager create-secret \
  --name "balancer-dev-config" \
  --description "Development environment configuration" \
  --secret-string '{
    "DATABASE_URL": "postgresql://user:pass@dev-db:5432/balancer_dev",
    "SUBGRAPH_API_URL": "https://api.studio.thegraph.com/query/24/balancer-v2-dev/version/latest",
    "SENTRY_DSN": "https://your-dev-sentry-dsn@sentry.io/project",
    "AWS_REGION": "us-east-1",
    "NODE_ENV": "development"
  }'

# Staging secrets
aws secretsmanager create-secret \
  --name "balancer-staging-config" \
  --description "Staging environment configuration" \
  --secret-string '{
    "DATABASE_URL": "postgresql://user:pass@staging-db:5432/balancer_staging",
    "SUBGRAPH_API_URL": "https://api.studio.thegraph.com/query/24/balancer-v2-staging/version/latest",
    "SENTRY_DSN": "https://your-staging-sentry-dsn@sentry.io/project",
    "AWS_REGION": "us-east-1",
    "NODE_ENV": "staging"
  }'

# Production secrets (more sensitive)
aws secretsmanager create-secret \
  --name "balancer-production-config" \
  --description "Production environment configuration" \
  --secret-string '{
    "DATABASE_URL": "postgresql://user:pass@prod-db:5432/balancer_prod",
    "SUBGRAPH_API_URL": "https://api.studio.thegraph.com/query/24/balancer-v2/version/latest",
    "SENTRY_DSN": "https://your-prod-sentry-dsn@sentry.io/project",
    "AWS_REGION": "us-east-1",
    "NODE_ENV": "production"
  }'
```

### **4. DNS and Subdomain Setup**

#### **Overview: Automatic DNS Validation**

Our infrastructure now uses **Route53 hosted zones** for automatic SSL certificate validation, eliminating manual email verification that can block CI/CD deployments.

#### **A. Domain Structure**

| Environment     | Subdomain     | Root Domain      | Example URL                          |
| --------------- | ------------- | ---------------- | ------------------------------------ |
| **Development** | `dev-api`     | `hyperchonk.com` | `https://dev-api.hyperchonk.com`     |
| **Staging**     | `staging-api` | `hyperchonk.com` | `https://staging-api.hyperchonk.com` |
| **Production**  | `api`         | `hyperchonk.com` | `https://api.hyperchonk.com`         |

#### **B. One-Time Domain Setup Process**

**Step 1: Deploy Infrastructure with Hosted Zone**

```bash
# Deploy development environment (includes hosted zone creation)
cd infrastructure
npm run deploy:dev

# This automatically creates:
# - Route53 hosted zone for hyperchonk.com
# - SSL certificate for dev-api.hyperchonk.com (with DNS validation)
# - All necessary DNS records
```

**Step 2: Update Domain Nameservers (One-Time Setup)**

After the first deployment, you'll see output like:

```
✅ SetupInstructions: Go to your domain registrar (GoDaddy) and update nameservers for hyperchonk.com to:
   ns-1234.awsdns-12.co.uk, ns-567.awsdns-89.net, ns-890.awsdns-01.org, ns-123.awsdns-45.com
```

**At GoDaddy (or your domain registrar):**

1. Log into your domain management dashboard
2. Navigate to DNS settings for `hyperchonk.com`
3. Replace the default nameservers with the AWS Route53 nameservers from the output
4. Save changes

**Step 3: Verify DNS Propagation**

```bash
# Check if nameservers have propagated (takes 5-60 minutes)
dig NS hyperchonk.com

# Should return AWS nameservers like:
# hyperchonk.com. 86400 IN NS ns-1234.awsdns-12.co.uk.
# hyperchonk.com. 86400 IN NS ns-567.awsdns-89.net.
```

**Step 4: Deploy Other Environments**

```bash
# Once nameservers are updated, deploy other environments
npm run deploy:staging  # Creates staging-api.hyperchonk.com automatically
npm run deploy:prod     # Creates api.hyperchonk.com automatically

# All subdomains now get automatic SSL certificates via DNS validation! 🎉
```

#### **C. How It Works (Technical Details)**

**Route53 Hosted Zone (hyperchonk.com):**

-   Created automatically by `HostedZoneStack`
-   Manages DNS for the root domain and all subdomains
-   Enables automatic SSL certificate validation

**Subdomain Automation:**

-   No manual CNAME records needed
-   Subdomains are created automatically when you deploy each environment
-   Load balancer gets an auto-generated AWS domain (e.g., `dev-alb-123456.us-east-1.elb.amazonaws.com`)
-   Route53 automatically creates A records pointing subdomain → load balancer

**SSL Certificate Validation:**

-   Certificates use DNS validation (not email)
-   Route53 automatically creates validation records
-   Certificates become `ISSUED` in 2-5 minutes
-   No manual intervention required

#### **D. Adding New Environments**

To add a new environment (e.g., `staging2`):

**1. Create Environment Config:**

```typescript
// infrastructure/config/environments/staging2.ts
export default {
    // ... copy from staging.ts
    ssl: {
        enabled: true,
        domainName: 'staging2-api.hyperchonk.com', // New subdomain
        rootDomain: 'hyperchonk.com', // Same root domain
    },
};
```

**2. Deploy Infrastructure:**

```bash
npm run deploy:staging2
# Automatically creates staging2-api.hyperchonk.com with SSL certificate
```

**That's it!** No additional DNS setup needed - Route53 handles everything automatically.

#### **E. Troubleshooting DNS Issues**

**Common Issues:**

| Issue                                  | Cause                   | Solution                                  |
| -------------------------------------- | ----------------------- | ----------------------------------------- |
| Certificate stuck `PENDING_VALIDATION` | Nameservers not updated | Update nameservers at registrar           |
| Subdomain not resolving                | DNS not propagated      | Wait 5-60 minutes, check with `dig`       |
| SSL errors in browser                  | Wrong domain in config  | Verify `domainName` in environment config |

**Debug Commands:**

```bash
# Check hosted zone status
aws route53 list-hosted-zones --query 'HostedZones[?Name==`hyperchonk.com.`]'

# Check certificate status
aws acm list-certificates --query 'CertificateSummaryList[?DomainName==`dev-api.hyperchonk.com`]'

# Test DNS resolution
dig dev-api.hyperchonk.com
nslookup dev-api.hyperchonk.com

# Check infrastructure status
npm run check-status:dev
```

#### **F. Cost Impact**

| Resource            | Cost                  | Notes                                     |
| ------------------- | --------------------- | ----------------------------------------- |
| Route53 Hosted Zone | $0.50/month           | One-time setup per root domain            |
| DNS Queries         | $0.40/million queries | Very low for typical usage                |
| **Total**           | **~$0.50/month**      | Much cheaper than email validation delays |

### **5. GitHub Actions Setup**

#### **A. AWS OIDC Role (Secure Authentication)**

```bash
# Create OIDC role for GitHub Actions (one-time setup)
# This allows GitHub to assume AWS roles without long-lived keys

aws iam create-role \
  --role-name GitHubActions-Deploy-Role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": {
          "Federated": "arn:aws:iam::ACCOUNT-ID:oidc-provider/token.actions.githubusercontent.com"
        },
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Condition": {
          "StringEquals": {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
          },
          "StringLike": {
            "token.actions.githubusercontent.com:sub": "repo:your-org/balancer-v3-backend:*"
          }
        }
      }
    ]
  }'
```

#### **B. GitHub Secrets Configuration**

```bash
# Required GitHub repository secrets:
AWS_DEPLOY_ROLE_ARN=arn:aws:iam::123456789012:role/GitHubActions-Deploy-Role
```

#### **C. GitHub Environment Protection**

-   Navigate to your repository → Settings → Environments
-   Create "production" environment
-   Enable "Required reviewers" for production deployments
-   Add deployment branch rules (main only)

## 📦 Container Details

### **Docker Image Optimization**

```dockerfile
# Multi-stage build for efficiency
FROM node:18-alpine AS base       # Base layer
FROM base AS dependencies        # Dependencies layer
FROM base AS build              # Build layer
FROM node:18-alpine AS production # Final optimized layer (uses Bun)

# Features:
# • Bun for fast package management and hot reloading
# • Multi-stage builds (prod image ~200MB)
# • Non-root user for security
# • Health checks built-in
# • Secrets initialization at startup
# • Graceful shutdown handling
```

### **Secrets Management in Containers**

```bash
# Container startup process:
1. Container starts
2. init-secrets.sh runs
3. Fetches JSON config from AWS Secrets Manager
4. Converts to environment variables
5. Validates required variables
6. Starts main application

# Local development:
# Uses .env file instead of AWS Secrets Manager
```

## 🔍 Monitoring & Health Checks

### **Enterprise-Grade Infrastructure Monitoring**

The `check-status.ts` script provides comprehensive AWS infrastructure monitoring with **AI-optimized output formats** for maximum operational intelligence. It validates 21+ components including SSL certificates, domain configuration, and environment compliance.

#### **AI-Optimized Output Formats**

```bash
# YAML format (80% more token-efficient for LLM analysis)
npm run check-status:yaml:dev
npm run check-status:yaml:staging
npm run check-status:yaml:prod

# Executive Summary (key metrics + issue identification)
npm run check-status:summary:dev
npm run check-status:summary:staging
npm run check-status:summary:prod

# Combined YAML + Summary (default for optimal AI analysis)
npm run check-status:dev
npm run check-status:staging
npm run check-status:prod

# Verbose debugging mode
npm run check-status:verbose:dev
npm run check-status:verbose:staging
npm run check-status:verbose:prod

# JSON format (machine-readable automation)
npm run check-status:json:dev
npm run check-status:json:staging
npm run check-status:json:prod
```

#### **Comprehensive Component Validation**

-   **SSL Certificate Monitoring**: Status, expiration tracking, domain validation
-   **Load Balancer Analysis**: HTTP/HTTPS listener configuration
-   **Domain-Aware Health Checks**: Eliminates certificate mismatch issues
-   **Environment Compliance**: Dev/staging/production-specific validation
-   **CloudFormation Stacks**: Status and recent events analysis
-   **ECS Services**: Task health, scaling, and failure analysis
-   **RDS Databases**: Connectivity and performance validation
-   **S3 Buckets**: Accessibility and permissions verification

### **Health Check Endpoints**

```bash
# Domain-aware health checks (automatically resolves correct URLs)
node scripts/get-environment-config.js development  # Returns: https://dev-api.hyperchonk.com
node scripts/get-environment-config.js staging      # Returns: https://staging-api.hyperchonk.com
node scripts/get-environment-config.js production   # Returns: https://api.hyperchonk.com

# Test actual endpoints
curl https://dev-api.hyperchonk.com/health
# Returns: {"status":"healthy","uptime":3600,"memory":{"used":128,"total":512}}

curl https://dev-api.hyperchonk.com/health/ready
# Returns: {"status":"ready","database":"connected"}
```

### **Monitoring Stack**

-   **CloudWatch**: Application logs, metrics, alarms
-   **X-Ray**: Distributed tracing for GraphQL operations
-   **Sentry**: Error tracking and performance monitoring
-   **ALB**: Health checks and traffic distribution
-   **ACM**: SSL certificate monitoring and validation
-   **Route 53**: DNS health checks and domain validation

## 🛠️ Development Workflow

### **Local Development**

```bash
# 1. Clone and setup
git clone <repo>
cd balancer-v3-backend
bun install

# 2. Database setup
docker compose up -d postgres
bun prisma migrate dev
bun prisma generate

# 3. Start development server
bun dev    # Uses hot reloading with Bun
```

### **Testing Deployments**

```bash
# Test Docker build locally
docker build -t balancer-api:test .
docker run -p 3000:3000 balancer-api:test

# Test comprehensive infrastructure status
npm run check-status:verbose:dev

# Test domain-aware health checks
HEALTH_URL=$(node scripts/get-environment-config.js development)
curl -v "$HEALTH_URL/health"

# Test secrets initialization
./scripts/init-secrets.sh
```

### **Branch Strategy**

```
main (production)
  ↑
staging (staging environment)
  ↑
develop (development environment)
  ↑
feature/xyz (feature branches)
```

## 🚨 Troubleshooting

### **Infrastructure Status Checker**

The `check-status.ts` script provides comprehensive AWS infrastructure monitoring and debugging capabilities. It checks the health of your CloudFormation stacks, ECS services, RDS databases, S3 buckets, and load balancers.

#### **Quick Start**

```bash
# AI-optimized monitoring (YAML + Summary - default)
npm run check-status:dev
npm run check-status:staging
npm run check-status:prod

# Token-efficient YAML format (80% fewer tokens for LLM analysis)
npm run check-status:yaml:dev

# Executive summary with key metrics
npm run check-status:summary:dev

# Comprehensive debugging
npm run check-status:verbose:dev

# Machine-readable JSON for automation
npm run check-status:json:dev
```

#### **Available Commands**

| Command                            | Description                         | Use Case                    |
| ---------------------------------- | ----------------------------------- | --------------------------- |
| `npm run check-status:dev`         | YAML + Summary (AI-optimized)       | Daily development work      |
| `npm run check-status:yaml:dev`    | YAML format only (80% fewer tokens) | LLM analysis and automation |
| `npm run check-status:summary:dev` | Executive summary only              | Quick status overview       |
| `npm run check-status:verbose:dev` | Full debugging information          | Deep troubleshooting        |
| `npm run check-status:json:dev`    | JSON format for automation          | CI/CD integration           |

**Environment Variants:** Replace `:dev` with `:staging` or `:prod` for other environments.

#### **Legacy Command Options** (still supported)

```bash
# Direct script execution with flags
npm run check-status -- --env development --yaml --summary
npm run check-status -- --env staging --json --quiet
npm run check-status -- --env production --verbose --debug
```

#### **Understanding the Output**

**Human-Readable Report:**

```bash
🏗️  AWS Infrastructure Status Report
==========================================
Environment: development
Region: us-east-1
Timestamp: 2025-06-03T04:43:14.861Z

📊 Summary:
  ✅ Healthy: 12
  ⚠️  Warning: 3
  ❌ Error: 0
  📊 Total: 15

🔧 CLOUDFORMATION:
  ⚠️ Stack v3-backend-development-compute: CREATE_IN_PROGRESS (Operation in progress) - 12 resources may be stuck
     🔍 Stuck Resources:
       - APIServiceC212E51D: CREATE_IN_PROGRESS
         Reason: Eventual consistency check initiated

🔧 ECS:
  ⚠️ Service v3-backend-development-api-service: 0/1 tasks running (Some tasks not running)
     🔍 Task Issues: 5 tasks failed with exit code 1 (application error)

🔍 DEBUGGING INFORMATION:
==========================================
📋 Stuck Services Analysis:
  • ECS-Service-v3-backend-development-api-service: Missing secret keys
    Issues: ResourceInitializationError - SQS_BACKGROUND_JOB_QUEUE_URL not found

🔗 Load Balancer Analysis:
  • v3-backend-development-alb: active
    - v3-backend-development-api-tg: 0/0 healthy
```

**Status Indicators:**

-   ✅ **Healthy**: Resource is working correctly
-   ⚠️ **Warning**: Resource has issues but is operational
-   ❌ **Error**: Resource is failed or inaccessible
-   ❓ **Unknown**: Unable to determine status

#### **Exit Codes**

The script returns different exit codes for automation:

```bash
0  # All services healthy
1  # One or more services have errors
2  # One or more services have warnings
3  # Script execution failed
```

#### **Common Use Cases**

**1. Deployment Stuck Investigation**

```bash
# When CloudFormation deployment hangs
npm run check-status:dev

# Look for:
# - Stack status: CREATE_IN_PROGRESS
# - Stuck resources with "Eventual consistency check initiated"
# - ECS task failure reasons
# - Missing secrets or configuration
```

**2. Service Health Monitoring**

```bash
# Quick health check across all services
npm run check-status:prod --quiet

# Automated monitoring (returns exit code)
if ! npm run check-status:prod --json > /dev/null; then
  echo "Production issues detected!"
fi
```

**3. Container Startup Failures**

```bash
# Debug why ECS tasks won't start
npm run check-status:dev --debug

# Common issues identified:
# - Missing environment variables
# - Secret retrieval errors
# - Image pull failures
# - Health check failures
```

**4. Load Balancer Target Issues**

```bash
# Check why ALB shows no healthy targets
npm run check-status:staging

# Shows:
# - Target group health status
# - Unhealthy target reasons
# - ECS service scaling issues
```

#### **JSON Output for Automation**

For CI/CD pipelines and automated monitoring:

```bash
# Get machine-readable status
npm run check-status:prod --json | jq '.summary'
{
  "healthy": 12,
  "warning": 1,
  "error": 0,
  "total": 13
}

# Check specific service status
npm run check-status:dev --json | jq '.services[] | select(.service | contains("ECS-Service"))'

# Extract debugging information
npm run check-status:dev --json | jq '.debugging.stuckServices'
```

#### **Integration with Monitoring**

**CloudWatch Dashboard Integration:**

```bash
# Add status check to CloudWatch custom metrics
aws cloudwatch put-metric-data \
  --namespace "Balancer/Infrastructure" \
  --metric-data MetricName=HealthyServices,Value=$(npm run check-status:prod --json | jq '.summary.healthy')
```

**Alert Integration:**

```bash
# Use in health check scripts
#!/bin/bash
STATUS=$(npm run check-status:prod --json | jq -r '.summary')
if [ "$STATUS.error" -gt 0 ]; then
  # Send alert to Slack/email
  curl -X POST webhook-url -d "Production errors detected: $STATUS"
fi
```

### **Environment Variable Inspector**

The `inspect-env-vars.ts` script provides comprehensive environment variable inspection and debugging for ECS services. This tool helps identify configuration issues and validates that containers are running with the correct environment variables.

#### **Quick Start**

```bash
# Inspect all environment variables for development
npm run inspect-env-vars:dev

# Inspect production environment variables (sensitive data masked)
npm run inspect-env-vars:prod

# Show only database-related variables
npm run inspect-env-vars:database
```

#### **Common Use Cases**

**1. Debug Configuration Issues**

```bash
# When services fail to start due to missing environment variables
npm run inspect-env-vars:api

# Check if required variables are set (custom filter)
npm run inspect-env-vars -- --env production --filter "NODE_ENV,DATABASE_URL"
```

**2. Validate Deployment Configuration**

```bash
# Compare environment variables between environments
npm run inspect-env-vars:staging:compact
npm run inspect-env-vars:prod:compact

# Export configuration for analysis
npm run inspect-env-vars:prod:json > prod-env-vars.json
```

**3. Security Audit**

```bash
# Review all sensitive variables (masked by default)
npm run inspect-env-vars:secrets

# Show unmasked values in development only (use with caution)
npm run inspect-env-vars -- --env development --no-mask
```

#### **Output Formats**

```bash
# Table format (default, human-readable)
npm run inspect-env-vars:dev

# JSON format (for automation)
npm run inspect-env-vars:prod:json

# Compact format (overview)
npm run inspect-env-vars:staging:compact
```

#### **Integration with Status Checker**

```bash
# First check infrastructure health
npm run check-status:dev

# If configuration issues are detected, inspect environment variables
npm run inspect-env-vars:dev

# Common workflow for debugging deployment issues
npm run check-status:dev --verbose && npm run inspect-env-vars:database
```

For detailed usage and examples, see [inspect-env-vars.md](./scripts/inspect-env-vars.md).

### **Common Issues**

#### **1. Deployment Failures**

```bash
# Check GitHub Actions logs
# Navigate to: Repository → Actions → Failed workflow

# Check ECS service status
aws ecs describe-services \
  --cluster balancer-dev-cluster \
  --services balancer-dev-api-service

# Check container logs
aws logs tail /aws/ecs/balancer-dev --follow
```

#### **1a. CDK Synthesis Warnings (VPC Lookup Issues)**

If you see warnings like these during `cdk synth`:

```
⚠️ fromVpcAttributes: '...' is a list token
⚠️ No routeTableId was provided
⚠️ minHealthyPercent has not been configured
```

**Solution for New Environments:**

```bash
# Deploy networking stack first to establish VPC context
npx cdk deploy v3-backend-development-networking

# Then deploy all stacks (warnings should disappear)
npx cdk deploy --all
```

**For Existing Environments:**
If you encounter these warnings on existing environments, clear the CDK context:

```bash
# Remove cached VPC context
rm cdk.context.json

# Redeploy networking stack to refresh context
npx cdk deploy v3-backend-development-networking
npx cdk deploy --all
```

**Why This Happens:**

-   Cross-stack dependencies require the referenced resources to exist first
-   Direct construct passing creates explicit CloudFormation dependencies
-   The networking stack must be deployed before dependent stacks can reference its constructs

#### **2. Health Check Failures**

```bash
# Get environment-specific health URL (eliminates SSL mismatch issues)
HEALTH_URL=$(node scripts/get-environment-config.js development)
echo "Testing: $HEALTH_URL"

# Test health endpoint with SSL validation
curl -v "$HEALTH_URL/health" --ssl-reqd --cert-status

# Comprehensive infrastructure validation with debugging
npm run check-status:verbose:dev

# Check container health
aws ecs describe-tasks \
  --cluster balancer-dev-cluster \
  --tasks $(aws ecs list-tasks --cluster balancer-dev-cluster --query 'taskArns[0]' --output text)

# SSL certificate status check
npm run check-status:summary:dev | grep -A5 "Certificate"
```

#### **3. Database Connection Issues**

```bash
# Check database status
aws rds describe-db-instances \
  --db-instance-identifier balancer-dev-db

# Test database connection from container
aws ecs run-task \
  --cluster balancer-dev-cluster \
  --task-definition balancer-dev-migration-task \
  --overrides '{"containerOverrides":[{"name":"balancer-api","command":["sh","-c","./scripts/init-secrets.sh && npx prisma db pull"]}]}'
```

#### **4. Secrets Issues**

```bash
# Verify secrets exist
aws secretsmanager list-secrets \
  --query 'SecretList[?contains(Name, `balancer`)].Name'

# Test secret retrieval
aws secretsmanager get-secret-value \
  --secret-id balancer-dev-config \
  --query SecretString \
  --output text
```

### **Performance Optimization**

#### **Container Performance**

```bash
# Monitor container metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS \
  --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=balancer-dev-api-service \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-02T00:00:00Z \
  --period 300 \
  --statistics Average
```

#### **Database Performance**

```bash
# Check database performance insights
aws rds describe-db-instances \
  --db-instance-identifier balancer-dev-db \
  --query 'DBInstances[0].PerformanceInsightsEnabled'

# Optimize Prisma queries
bun prisma studio    # Visual database browser
```

## 🔄 Rollback Procedures

### **Application Rollback**

```bash
# 1. Identify previous working image
aws ecr describe-images \
  --repository-name balancer-api \
  --query 'sort_by(imageDetails,&imagePushedAt)[-2:]'

# 2. Deploy previous image
cd infrastructure
npx cdk deploy production-stack \
  --context imageUri=123456789012.dkr.ecr.us-east-1.amazonaws.com/balancer-api:previous-sha

# 3. Verify rollback
curl https://prod-alb-url/health
```

### **Database Rollback**

```bash
# 1. Stop application traffic
aws elbv2 modify-target-group \
  --target-group-arn arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/balancer-prod-tg/1234567890123456 \
  --health-check-enabled false

# 2. Restore from snapshot
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier balancer-production-db-restored \
  --db-snapshot-identifier balancer-prod-pre-deploy-20241220-123456

# 3. Update connection strings and restart
```

## 📊 Cost Optimization

### **Environment Sizing**

| Environment | vCPU | Memory  | Database   | Monthly Cost (Est.) |
| ----------- | ---- | ------- | ---------- | ------------------- |
| Development | 0.25 | 512MB   | t3.micro   | ~$30                |
| Staging     | 0.5  | 1024MB  | t3.small   | ~$60                |
| Production  | 1.0+ | 2048MB+ | t3.medium+ | ~$150+              |

### **Cost Monitoring**

```bash
# Set up budget alerts
aws budgets create-budget \
  --account-id 123456789012 \
  --budget '{
    "BudgetName": "balancer-infrastructure",
    "BudgetLimit": {"Amount": "200", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST"
  }'
```

## 🔐 Security Best Practices

-   ✅ **No long-lived AWS keys** (uses OIDC)
-   ✅ **Secrets in AWS Secrets Manager** (not environment variables)
-   ✅ **Container image scanning** (automated in CI/CD)
-   ✅ **Non-root container users**
-   ✅ **VPC with private subnets**
-   ✅ **Security groups with minimal access**
-   ✅ **Encrypted RDS and S3**
-   ✅ **WAF protection** for GraphQL endpoints

## 🚀 Quick Reference

### **Most Used Commands**

```bash
# Daily development monitoring (AI-optimized)
npm run check-status:dev

# Quick health check for production
npm run check-status:summary:prod

# Deep troubleshooting
npm run check-status:verbose:dev

# Get environment-specific URL
node scripts/get-environment-config.js development

# Deploy infrastructure (existing environments)
npm run deploy:dev
npm run deploy:staging
npm run deploy:prod

# First-time deployment (new environments)
npx cdk deploy v3-backend-development-networking && npx cdk deploy --all
npx cdk deploy v3-backend-staging-networking && npx cdk deploy --all
npx cdk deploy v3-backend-production-networking && npx cdk deploy --all
```

### **Emergency Commands**

```bash
# Check all services quickly
npm run check-status:json:prod | jq '.summary'

# Get SSL certificate status
npm run check-status:summary:prod | grep -A5 "Certificate"

# Check load balancer health
npm run check-status:yaml:prod | grep -A10 "load_balancers"

# Test specific endpoint
curl -f "$(node scripts/get-environment-config.js production)/health"
```

## 📚 Additional Resources

-   [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
-   [GitHub Actions Documentation](https://docs.github.com/en/actions)
-   [Prisma Documentation](https://www.prisma.io/docs/)
-   [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)
-   [AWS ECS Documentation](https://docs.aws.amazon.com/ecs/)

### Deploying a single stack

You can deploy a specific stack by passing its name to the `cdk deploy` command.

```bash
# Example for compute stack
npx cdk deploy v3-backend-development-compute \
  --context environment=development \
  --context imageUri=123456789012.dkr.ecr.us-east-1.amazonaws.com/v3-backend:latest
```

### Running commands on the cluster

To run commands on the ECS cluster, you can use `aws ecs execute-command`.

```bash
aws ecs execute-command --cluster v3-backend-development-cluster \
  --service v3-backend-development-api-service \
  --task <task-id> \
  --command "/bin/bash" \
  --interactive
```
