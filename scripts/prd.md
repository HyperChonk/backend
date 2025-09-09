# Product Requirements Document: AWS Infrastructure for Balancer GraphQL API

## 1. Overview

This PRD outlines the requirements for AWS infrastructure to support a GraphQL API written in TypeScript using Apollo Server. The API aggregates data from Subgraph and other external APIs, storing it in a PostgreSQL database using Prisma ORM. The infrastructure uses ECS with Fargate launch type and AWS CDK for Infrastructure as Code, with separate environment stacks optimized for cost efficiency. The system includes background job processing via SQS and comprehensive secrets management.

## 2. Objectives

-   Deploy reliable, scalable AWS infrastructure using AWS CDK (TypeScript) for Infrastructure as Code
-   Implement containerized deployment using ECS Fargate for operational simplicity with Node.js 18 runtime
-   Support GraphQL-specific infrastructure requirements including Apollo Server optimization
-   Implement Prisma ORM database management with automated migrations
-   Enable background job processing through SQS integration
-   Ensure container recovery with automatic replacement of failed tasks
-   Support separate environment stacks with independent resource management
-   Implement unified secrets management using JSON configuration per environment
-   Automate CI/CD with GitHub Actions and AWS container deployment services
-   Optimize for cost efficiency while maintaining operational reliability

## 3. Technical Architecture

### 3.1 Core Technology Stack

-   **GraphQL Server**: Apollo Server v4.11.3 with TypeScript
-   **ORM**: Prisma v6.3.0 for PostgreSQL database management
-   **Container Orchestration**: ECS with Fargate launch type
-   **Runtime**: Node.js 18 (development uses Bun for hot-reloading)
-   **Infrastructure as Code**: AWS CDK (TypeScript)
-   **Database**: Amazon RDS PostgreSQL (single-AZ) with Prisma schema management
-   **Background Processing**: Amazon SQS for job queuing
-   **Load Balancing**: Application Load Balancer (ALB)
-   **Container Registry**: Amazon ECR
-   **Deployment**: GitHub Actions + ECS rolling deployments
-   **Error Tracking**: Sentry integration for comprehensive error monitoring

### 3.2 Environment Strategy

-   **Separate CDK Stacks**: Independent stacks per environment (`dev-stack`, `staging-stack`, `prod-stack`)
-   **Isolated Resources**: Dedicated RDS instances, ECS services, and SQS queues per environment
-   **Environment-Specific Secrets**: JSON configuration secrets per environment in AWS Secrets Manager
-   **Independent Scaling**: Environment-specific configurations and scaling policies
-   **Database Schema Management**: Prisma migrations per environment with automated deployment
-   **Cost Optimization**: Right-sized resources per environment needs

## 4. Infrastructure Requirements

### 4.1 Networking & Security

-   **VPC**: Virtual Private Cloud with public and private subnets in single AZ per environment
-   **Security Groups**:
    -   Application-level firewall rules for container and database access
    -   SQS access for background job processing
    -   Database admin tool access (when enabled)
-   **WAF**: Web Application Firewall for GraphQL API protection against query complexity attacks
-   **Secrets Manager**:
    -   JSON configuration secrets per environment containing all .env variables
    -   Automatic rotation capabilities for database credentials
    -   IAM-based access control per environment

### 4.2 Container Infrastructure

-   **ECS Clusters**: Separate Fargate cluster per environment
-   **ECS Services**:
    -   Main GraphQL API service with auto-scaling capability
    -   Background job processor service (SQS consumer)
-   **Container Configuration**:
    -   Node.js 18 runtime with Prisma CLI available
    -   Secrets initialization script to convert JSON config to environment variables
    -   Health check endpoints for both GraphQL and background processors
-   **ECR Repository**: Private container registry for application images (shared across environments)
-   **Application Load Balancer**:
    -   Environment-specific ALBs with GraphQL endpoint routing
    -   SSL termination with ACM certificates
    -   Health checks for GraphQL API endpoints
    -   Rate limiting for GraphQL queries

### 4.3 Database & Storage

-   **RDS PostgreSQL** (per environment):
    -   Single-AZ instances for cost optimization
    -   Prisma-managed schema with automated migrations
    -   Connection pooling configuration for container workloads
    -   Automated backups with 7-day retention
    -   Performance monitoring enabled
    -   Encryption at rest
    -   Environment-appropriate instance sizes:
        -   Dev: db.t3.micro with minimal storage
        -   Staging: db.t3.small with moderate storage
        -   Production: db.t3.medium with optimized storage
-   **Database Administration**:
    -   Optional database administration tools (pgAdmin or similar) for easy access
    -   Secure access through VPN or bastion host configuration
    -   Read-only access for debugging and analytics
-   **S3 Buckets**:
    -   Private, encrypted bucket for deployment artifacts and logs
    -   Versioning enabled for artifact management
    -   Prisma migration backup storage

### 4.4 Background Processing

-   **SQS Queues** (per environment):
    -   Standard queues for background job processing
    -   Dead letter queues for failed job handling
    -   Visibility timeout configured for job processing duration
    -   Queue monitoring and alerting
-   **ECS Background Services**:
    -   Dedicated Fargate tasks for SQS message processing
    -   Auto-scaling based on queue depth
    -   Shared codebase with main API but different entrypoint

### 4.5 Secrets Management Strategy

-   **JSON Configuration Approach**:
    -   Single AWS Secrets Manager secret per environment containing all configuration
    -   JSON structure with all environment variables (database URLs, API keys, feature flags)
    -   Container initialization script that:
        -   Pulls JSON secret at startup
        -   Converts to .env format
        -   Makes available to Node.js/Bun process
-   **Secret Structure Example**:
    ```json
    {
        "DATABASE_URL": "postgresql://...",
        "SUBGRAPH_API_URL": "https://...",
        "SENTRY_DSN": "https://...",
        "AWS_REGION": "us-east-1",
        "SQS_QUEUE_URL": "https://sqs...",
        "NODE_ENV": "production"
    }
    ```

### 4.6 Identity & Access Management

-   **ECS Task Roles**:
    -   Least-privilege access for containers to AWS services
    -   Secrets Manager read access for configuration retrieval
    -   SQS access for background job processing
    -   CloudWatch logging permissions
-   **GitHub Actions Role**: Cross-account role for CI/CD operations with Prisma migration capabilities
-   **Environment-Specific IAM**: Separate roles and policies per environment
-   **Database Access Roles**: Limited-scope roles for database administration tools

## 5. Continuous Integration and Deployment

### 5.1 GitHub Actions CI Pipeline

-   **Automated Testing**: Build, test, and lint on pushes to `develop`, `staging`, and `main`
-   **GraphQL Schema Validation**: Ensure schema changes don't break existing queries
-   **Prisma Integration**:
    -   Database schema validation
    -   Migration generation and validation
    -   Prisma client generation
-   **Container Image Building**:
    -   Docker multi-stage builds optimized for Node.js 18
    -   Prisma CLI and dependencies included
    -   Secrets initialization script embedded
-   **Security Scanning**: Container image vulnerability assessment
-   **Artifact Management**: Tagged container images in ECR with commit SHA versioning

### 5.2 Deployment Strategy

-   **Environment Triggers**:
    -   `develop` branch → automatic deployment to dev environment
    -   `staging` branch → automatic deployment to staging environment
    -   `main` branch → manual deployment to production via GitHub Actions UI
-   **Database Migration Process**:
    -   Automated Prisma migrations during deployment
    -   Migration rollback procedures for failed deployments
    -   Database backup before production migrations
-   **Deployment Method**:
    -   ECS rolling deployments with health checks
    -   Background service deployment coordination
    -   SQS queue management during deployments
-   **Rollback Capability**:
    -   Previous container image versions maintained for quick rollback
    -   Database migration rollback procedures
    -   Coordinated rollback for both API and background services
-   **Zero-Downtime Deployments**: ALB health checks ensure traffic routing to healthy containers

## 6. Monitoring & Observability

### 6.1 Application Monitoring

-   **CloudWatch Integration**:
    -   Custom metrics for GraphQL query performance and complexity
    -   Container resource utilization monitoring
    -   Database performance metrics and connection pool status
    -   SQS queue depth and processing metrics
-   **GraphQL-Specific Monitoring**:
    -   Query execution time tracking
    -   Resolver performance metrics
    -   Query complexity analysis and alerting
    -   Error rate tracking per GraphQL operation
-   **Sentry Integration**:
    -   Comprehensive error tracking and performance monitoring
    -   GraphQL operation tracing
    -   Background job error tracking
-   **Application Performance Monitoring**:
    -   AWS X-Ray for distributed tracing across GraphQL resolvers
    -   Structured logging with CloudWatch Logs
    -   Database query performance tracking through Prisma
-   **Health Checks**:
    -   ALB health checks for GraphQL endpoint
    -   ECS health check configurations for both API and background services
    -   Database connectivity health checks

### 6.2 Alerting Strategy

-   **Critical Alerts**:
    -   Production GraphQL API failures and service unavailability
    -   Database connection failures
    -   SQS processing failures and dead letter queue accumulation
-   **Performance Alerts**:
    -   GraphQL query response time degradation
    -   Database performance degradation
    -   High queue depth warnings
-   **Security Alerts**:
    -   GraphQL query complexity threshold breaches
    -   Unusual query patterns or potential attacks
-   **Cost Monitoring**: Budget alerts and cost anomaly detection
-   **Operational Dashboards**: Environment-specific CloudWatch dashboards with GraphQL metrics

## 7. Scaling & Recovery

### 7.1 High Availability Strategy

-   **Container Recovery**: ECS automatically replaces failed containers for both API and background services
-   **Database Backups**: Automated backups with point-in-time recovery
-   **Auto-Scaling**:
    -   CPU and memory-based scaling triggers per environment
    -   SQS queue depth-based scaling for background processors
-   **GraphQL-Specific Scaling**: Query volume and response time based scaling

### 7.2 Disaster Recovery

-   **RDS Snapshots**: Daily automated snapshots with cross-region copy option
-   **Prisma Schema Backup**: Schema and migration history backup
-   **Container Images**: Multi-region ECR replication for image availability
-   **Infrastructure Recovery**: CDK stacks can recreate infrastructure in any region
-   **Data Recovery**: Point-in-time recovery capabilities for databases with Prisma schema restoration
-   **SQS Message Recovery**: Dead letter queue analysis and reprocessing procedures

## 8. Security Requirements

### 8.1 Data Protection

-   **Encryption**: At-rest encryption for RDS and S3, in-transit encryption for all communications
-   **Network Security**: Private subnets for containers and databases, minimal port exposure
-   **Access Control**: IAM roles with least-privilege principles, no long-lived access keys
-   **Secrets Security**:
    -   JSON configuration secrets encrypted in Secrets Manager
    -   Automatic rotation for database credentials
    -   No secrets in container images or environment variable definitions

### 8.2 GraphQL Security

-   **Query Complexity Limits**: Protection against expensive queries
-   **Query Depth Limits**: Prevention of deeply nested query attacks
-   **Rate Limiting**: Per-client and global rate limiting
-   **Introspection Control**: Disabled in production, enabled in development environments

### 8.3 Container Security

-   **Image Scanning**: Regular vulnerability scanning in CI pipeline
-   **Base Image Updates**: Automated security patching for container base images
-   **Runtime Security**: Container isolation and resource limits
-   **Secrets Handling**: Secure initialization and in-memory-only secrets storage

## 9. Cost Optimization

### 9.1 Resource Right-Sizing

-   **Development Environment**:
    -   Fargate: 0.25 vCPU, 512 MB for API service
    -   Background processor: 0.25 vCPU, 512 MB
    -   Database: db.t3.micro
-   **Staging Environment**:
    -   Fargate: 0.5 vCPU, 1024 MB for API service
    -   Background processor: 0.25 vCPU, 512 MB
    -   Database: db.t3.small
-   **Production Environment**:
    -   Fargate: 1 vCPU, 2048 MB for API service (scalable)
    -   Background processor: 0.5 vCPU, 1024 MB (auto-scaling)
    -   Database: db.t3.medium (scalable to larger classes)

### 9.2 Database Optimization

-   **Single-AZ Deployment**: Cost optimization over Multi-AZ redundancy
-   **Storage Optimization**: GP2 storage with monitoring for upgrade needs
-   **Connection Pooling**: Prisma connection pooling to minimize database connections
-   **Query Optimization**: Prisma query analysis and optimization

### 9.3 Cost Monitoring

-   **Resource Tagging**: Environment and service-based cost allocation
-   **Budget Alerts**: Monthly budget monitoring per environment
-   **Cost Dashboard**: Regular cost review and optimization opportunities
-   **SQS Cost Optimization**: Message batching and efficient processing patterns

## 10. External Dependencies

### 10.1 Subgraph Integration

-   **Network Access**: Outbound internet connectivity for Subgraph API calls
-   **Circuit Breaker Patterns**: Graceful handling of external service failures
-   **Error Handling**: Robust error handling and retry mechanisms for GraphQL federation

### 10.2 Third-Party APIs

-   **Rate Limiting**: Implement client-side rate limiting for external APIs
-   **Error Handling**: Robust error handling and retry mechanisms
-   **Monitoring**: Track external API response times and availability
-   **Background Processing**: Use SQS for handling API rate limits and retries

## 11. Implementation Specifications

### 11.1 CDK Stack Structure

```
balancer-v3-backend/                    # Your existing repo
├── apps/                               # Existing application code
├── modules/                            # Existing modules
├── prisma/                             # Existing Prisma schema and migrations
├── scripts/                            # Existing scripts
├── package.json                        # APPLICATION dependencies only
├── .nvmrc                             # Existing Node version constraint (shared)
├──
├── infrastructure/                     # NEW: Infrastructure as Code
│   ├── package.json                   # INFRASTRUCTURE dependencies only
│   ├── package-lock.json              # Infrastructure lockfile
│   ├── node_modules/                  # Infrastructure dependencies
│   ├── bin/
│   │   └── deploy.ts                  # CDK app entry point
│   ├── lib/
│   │   ├── stacks/
│   │   │   ├── networking-stack.ts    # VPC, subnets, security groups
│   │   │   ├── database-stack.ts      # RDS instance with Prisma configuration
│   │   │   ├── secrets-stack.ts       # Secrets Manager JSON configuration
│   │   │   ├── sqs-stack.ts          # SQS queues for background processing
│   │   │   ├── container-stack.ts     # ECS cluster, services, ALB
│   │   │   ├── monitoring-stack.ts    # CloudWatch, alarms, dashboards
│   │   │   └── pipeline-stack.ts      # CI/CD resources with Prisma integration
│   │   ├── constructs/                # Reusable CDK constructs
│   │   │   ├── graphql-service.ts     # GraphQL ECS service construct
│   │   │   ├── background-processor.ts# SQS processor construct
│   │   │   └── prisma-database.ts     # Database with migration support
│   │   └── shared/
│   │       ├── types.ts               # Common TypeScript types
│   │       └── utils.ts               # Helper functions
│   ├── config/
│   │   ├── environments/
│   │   │   ├── dev.ts                 # Development environment config
│   │   │   ├── staging.ts             # Staging environment config
│   │   │   └── prod.ts                # Production environment config
│   │   └── shared.ts                  # Shared configuration
│   ├── secrets/                       # Secret templates (not actual secrets)
│   │   ├── dev-config.template.json   # Development secrets template
│   │   ├── staging-config.template.json# Staging secrets template
│   │   └── prod-config.template.json  # Production secrets template
│   ├── scripts/                       # Infrastructure-specific scripts
│   │   ├── deploy.sh                  # Deployment helper scripts
│   │   ├── migrate-db.sh             # Database migration scripts
│   │   └── setup-secrets.sh          # Secrets initialization
│   ├── cdk.json                       # CDK configuration
│   └── tsconfig.json                 # TypeScript config for infrastructure
└── .github/
    └── workflows/
        ├── deploy-dev.yml             # Updated to include infrastructure
        ├── deploy-staging.yml         # Updated to include infrastructure
        └── deploy-prod.yml            # Updated to include infrastructure
```

### 11.2 Separate Package.json Structure

#### Root package.json (Application Dependencies)

```json
{
    "name": "backend",
    "version": "1.41.8",
    "description": "Backend service for Beethoven X and Balancer",
    "private": true,
    "engines": {
        "node": "^18.0.0",
        "npm": ">=8.0.0"
    },
    "scripts": {
        "start": "node dist/apps/main.js",
        "dev": "bun --hot run apps/main.ts",
        "build": "tsc -p tsconfig.build.json",
        "test": "vitest",
        "migrate": "prisma migrate deploy",
        "infra:install": "cd infrastructure && npm install",
        "infra:deploy": "cd infrastructure && npm run deploy",
        "infra:destroy": "cd infrastructure && npm run destroy"
    },
    "dependencies": {
        "@apollo/server": "^4.11.3",
        "@prisma/client": "^6.3.0",
        "graphql": "^16.10.0"
        // ... your existing app dependencies
    },
    "devDependencies": {
        "@types/node": "^18.19.74",
        "typescript": "^5.7.3",
        "vitest": "^3.0.8"
        // ... your existing dev dependencies (NO CDK here)
    }
}
```

#### infrastructure/package.json (Infrastructure Dependencies)

```json
{
    "name": "balancer-infrastructure",
    "version": "1.0.0",
    "description": "AWS Infrastructure for Balancer GraphQL API",
    "private": true,
    "engines": {
        "node": "^18.0.0",
        "npm": ">=8.0.0"
    },
    "scripts": {
        "build": "tsc",
        "watch": "tsc -w",
        "deploy": "cdk deploy --all --require-approval never",
        "deploy:dev": "cdk deploy dev-stack --require-approval never",
        "deploy:staging": "cdk deploy staging-stack --require-approval never",
        "deploy:prod": "cdk deploy prod-stack",
        "destroy": "cdk destroy --all",
        "diff": "cdk diff",
        "synth": "cdk synth",
        "lint": "eslint . --ext .ts",
        "test": "jest"
    },
    "dependencies": {
        "aws-cdk-lib": "^2.120.0",
        "constructs": "^10.3.0"
    },
    "devDependencies": {
        "@types/jest": "^29.5.8",
        "@types/node": "^18.19.74",
        "@typescript-eslint/eslint-plugin": "^6.12.0",
        "@typescript-eslint/parser": "^6.12.0",
        "aws-cdk": "^2.120.0",
        "eslint": "^8.54.0",
        "jest": "^29.7.0",
        "ts-jest": "^29.1.1",
        "typescript": "^5.7.3"
    }
}
```

### 11.3 Container Configuration

-   **Secrets Initialization**: Startup script to convert JSON secrets to environment variables
-   **Prisma Integration**: Database migration and client generation in container
-   **Multi-Service Support**: Single codebase supporting both API and background processing
-   **Health Checks**: GraphQL-specific health check endpoints

### 11.4 Environment Configuration

-   **Parameterized Deployments**: CDK context for environment-specific values
-   **Resource Naming**: Consistent naming convention with environment prefix
-   **Configuration Management**: JSON secrets per environment with automatic deployment
-   **Database Seeding**: Automated data seeding for development and staging environments

### 11.5 Container Build Strategy

#### Dockerfile Structure

```dockerfile
# Multi-stage build for production optimization
FROM node:18-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY .nvmrc ./

# Dependencies stage
FROM base AS dependencies
RUN npm ci --only=production && npm cache clean --force

# Build stage
FROM base AS build
COPY . .
RUN npm ci
RUN npm run build
RUN npx prisma generate

# Production stage
FROM node:18-alpine AS production
WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

# Copy built application
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

# Copy secrets initialization script
COPY scripts/init-secrets.sh ./scripts/
RUN chmod +x ./scripts/init-secrets.sh

USER nextjs

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node scripts/health-check.js

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Startup: initialize secrets, run migrations, start app
CMD ["sh", "-c", "./scripts/init-secrets.sh && npm run migrate && npm start"]
```

#### Multi-Service Container Support

```dockerfile
# Alternative entrypoints for different services
# API Service (default)
CMD ["sh", "-c", "./scripts/init-secrets.sh && npm run migrate && npm start"]

# Background Job Processor
# CMD ["sh", "-c", "./scripts/init-secrets.sh && node dist/apps/background-processor.js"]
```

#### Container Optimization Features

-   **Multi-stage builds**: Separate build and production stages for smaller final image
-   **Alpine Linux base**: Minimal attack surface and smaller image size
-   **Non-root user**: Security best practice for container runtime
-   **Signal handling**: Proper graceful shutdown with dumb-init
-   **Health checks**: Built-in container health monitoring
-   **Secrets initialization**: Secure environment variable setup at runtime
-   **Database migrations**: Automated schema updates during container startup

#### Development Container (docker-compose.yml enhancement)

```yaml
version: '3.8'
services:
    api:
        build:
            context: .
            target: build # Use build stage for development
        volumes:
            - .:/app
            - /app/node_modules
        environment:
            - NODE_ENV=development
        ports:
            - '3000:3000'
        depends_on:
            - postgres
            - redis

    postgres:
        image: postgres:15-alpine
        environment:
            POSTGRES_DB: balancer_dev
            POSTGRES_USER: balancer
            POSTGRES_PASSWORD: password
        ports:
            - '5432:5432'
        volumes:
            - postgres_data:/var/lib/postgresql/data

volumes:
    postgres_data:
```

#### Container Build Scripts

```bash
# scripts/build-container.sh
#!/bin/bash
set -e

ENVIRONMENT=${1:-dev}
IMAGE_TAG=${2:-latest}
ECR_REGISTRY=${3}

echo "Building container for environment: $ENVIRONMENT"

# Build the container
docker build -t balancer-api:$IMAGE_TAG .

# Tag for ECR if registry provided
if [ ! -z "$ECR_REGISTRY" ]; then
    docker tag balancer-api:$IMAGE_TAG $ECR_REGISTRY/balancer-api:$IMAGE_TAG
    echo "Tagged for ECR: $ECR_REGISTRY/balancer-api:$IMAGE_TAG"
fi

echo "Container build complete"
```

#### Required Application Scripts

##### Secrets Initialization Script (scripts/init-secrets.sh)

```bash
#!/bin/bash
set -e

echo "Initializing secrets..."

# Get AWS region from environment or default
AWS_REGION=${AWS_REGION:-us-east-1}

# Get environment from NODE_ENV or default to development
ENVIRONMENT=${NODE_ENV:-development}

# Construct secret name based on environment
SECRET_NAME="balancer-${ENVIRONMENT}-config"

echo "Fetching secret: $SECRET_NAME from region: $AWS_REGION"

# Fetch secret from AWS Secrets Manager
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --region $AWS_REGION \
  --secret-id $SECRET_NAME \
  --query SecretString \
  --output text)

# Parse JSON and convert to .env format
echo "$SECRET_JSON" | jq -r 'to_entries[] | "\(.key)=\(.value)"' > /tmp/.env

# Source the environment variables
set -a
source /tmp/.env
set +a

# Clean up temporary file
rm /tmp/.env

echo "Secrets initialized successfully"
```

##### Health Check Script (scripts/health-check.js)

```javascript
const http = require('http');

const options = {
    hostname: 'localhost',
    port: process.env.PORT || 3000,
    path: '/health',
    method: 'GET',
    timeout: 2000,
};

const healthCheck = http.request(options, (res) => {
    if (res.statusCode === 200) {
        process.exit(0);
    } else {
        console.error(`Health check failed with status: ${res.statusCode}`);
        process.exit(1);
    }
});

healthCheck.on('error', (err) => {
    console.error('Health check failed:', err.message);
    process.exit(1);
});

healthCheck.on('timeout', () => {
    console.error('Health check timed out');
    healthCheck.destroy();
    process.exit(1);
});

healthCheck.end();
```

### 11.6 Application Health Check Implementation

#### GraphQL API Health Endpoint

```typescript
// Add to your main application (apps/health/health.controller.ts)
export class HealthController {
    constructor(private prisma: PrismaService) {}

    @Get('/health')
    async healthCheck() {
        try {
            // Check database connectivity
            await this.prisma.$queryRaw`SELECT 1`;

            // Check memory usage
            const memUsage = process.memoryUsage();
            const memUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

            if (memUsagePercent > 90) {
                throw new Error(`High memory usage: ${memUsagePercent.toFixed(2)}%`);
            }

            return {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                memory: {
                    used: Math.round(memUsage.heapUsed / 1024 / 1024),
                    total: Math.round(memUsage.heapTotal / 1024 / 1024),
                    percent: Math.round(memUsagePercent),
                },
                database: 'connected',
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                timestamp: new Date().toISOString(),
            };
        }
    }

    @Get('/health/ready')
    async readinessCheck() {
        try {
            // More thorough checks for readiness
            await this.prisma.$queryRaw`SELECT COUNT(*) FROM pg_stat_activity`;

            return {
                status: 'ready',
                timestamp: new Date().toISOString(),
            };
        } catch (error) {
            throw new Error(`Service not ready: ${error.message}`);
        }
    }
}
```

### 11.7 Auto-Scaling and Resource Configuration

#### ECS Auto-Scaling Thresholds

##### GraphQL API Service

```typescript
// Infrastructure configuration for API auto-scaling
const apiAutoScaling = {
    minCapacity: {
        dev: 1,
        staging: 1,
        prod: 2,
    },
    maxCapacity: {
        dev: 2,
        staging: 3,
        prod: 10,
    },
    targetCpuUtilization: 70,
    targetMemoryUtilization: 80,
    scaleOutCooldown: Duration.minutes(3),
    scaleInCooldown: Duration.minutes(5),
};
```

##### Background Processor Service

```typescript
// SQS-based auto-scaling configuration
const backgroundAutoScaling = {
    minCapacity: {
        dev: 0,
        staging: 1,
        prod: 1,
    },
    maxCapacity: {
        dev: 1,
        staging: 2,
        prod: 5,
    },
    targetQueueDepth: 10, // Messages per task
    scaleOutCooldown: Duration.minutes(2),
    scaleInCooldown: Duration.minutes(10),
};
```

#### Container Resource Limits

```dockerfile
# Resource limits in ECS Task Definition
{
  "family": "balancer-api",
  "cpu": "1024",           # 1 vCPU
  "memory": "2048",        # 2 GB RAM
  "memoryReservation": "1536", # Soft limit
  "ulimits": [
    {
      "name": "nofile",
      "softLimit": 65536,
      "hardLimit": 65536
    }
  ]
}
```

#### Application-Level Configuration

```typescript
// apps/config/resource.config.ts
export const ResourceConfig = {
    database: {
        connectionPoolSize: {
            dev: 5,
            staging: 10,
            prod: 20,
        },
        connectionTimeout: 30000,
        queryTimeout: 60000,
    },
    graphql: {
        queryComplexityLimit: 1000,
        queryDepthLimit: 10,
        rateLimiting: {
            windowMs: 15 * 60 * 1000, // 15 minutes
            max: {
                dev: 1000,
                staging: 500,
                prod: 100,
            },
        },
    },
    background: {
        concurrentJobs: {
            dev: 2,
            staging: 5,
            prod: 10,
        },
        jobTimeout: 300000, // 5 minutes
        retryAttempts: 3,
    },
};
```

## 12. Success Criteria

### 12.1 Deployment Success

-   **Infrastructure Deployment**: All CDK stacks deploy successfully without manual intervention
-   **Database Migrations**: Prisma migrations execute successfully across all environments
-   **Secrets Management**: JSON configuration secrets properly deployed and accessible
-   **CI/CD Functionality**: Automated dev/staging deployments, manual production deployment
-   **Service Health**: All environments operational with proper health checks
-   **SQS Integration**: Background job processing functional across environments
-   **Security Validation**: Successful security scan of deployed infrastructure

### 12.2 Operational Success

-   **Cost Targets**: Monthly infrastructure costs within defined budget parameters
-   **Performance Baseline**: Acceptable GraphQL API response times across all environments
-   **Monitoring Coverage**: Comprehensive observability across all components
-   **Recovery Testing**: Successful container failure and recovery scenarios
-   **Database Performance**: Prisma query performance within acceptable limits
-   **Background Processing**: SQS job processing with acceptable latency and error rates

## 13. Risk Mitigation

### 13.1 Technical Risks

-   **Container Failures**: ECS auto-recovery and health check configurations
-   **Database Failures**: Automated backups and point-in-time recovery capabilities
-   **Migration Failures**: Prisma migration rollback procedures and database backups
-   **External API Failures**: Circuit breaker patterns and graceful degradation
-   **SQS Processing Failures**: Dead letter queues and retry mechanisms
-   **Image Vulnerabilities**: Automated security scanning and regular updates

### 13.2 Operational Risks

-   **Deployment Failures**: Rollback procedures and infrastructure testing
-   **Cost Overruns**: Budget monitoring and auto-scaling limits
-   **Performance Degradation**: Monitoring and alerting for early detection
-   **Secrets Management**: Secure handling and rotation of JSON configuration secrets

## 14. Future Enhancement Paths

### 14.1 High Availability Upgrades

-   **Multi-AZ RDS**: Enable when budget allows for enhanced database availability
-   **Cross-AZ Load Balancing**: Distribute containers across multiple AZs
-   **Read Replicas**: Database read scaling for high-traffic scenarios
-   **ElastiCache Integration**: GraphQL response caching when needed

### 14.2 Advanced Features

-   **Auto-Scaling Enhancements**: Custom GraphQL metrics-based scaling policies
-   **Advanced Monitoring**: GraphQL-specific APM tools integration
-   **Global Distribution**: CloudFront CDN for improved global GraphQL performance
-   **Advanced Background Processing**: Event-driven architectures with EventBridge
-   **Database Performance**: Advanced Prisma optimization and query analysis tools
