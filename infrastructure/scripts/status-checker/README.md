# AWS Status Checker

A modular AWS infrastructure status checking system that provides comprehensive health monitoring for the Balancer V3 backend.

## Overview

This system checks the health of various AWS services and provides detailed diagnostics when issues are detected. It's designed to be modular, extensible, and provide actionable insights.

## Architecture

### Core Components

-   **`aws-status-checker.ts`** - Main orchestrator class that coordinates all checks
-   **`types.ts`** - TypeScript interfaces and types used throughout the system
-   **`index.ts`** - Main export file for the module

### Utils

-   **`formatters.ts`** - Output formatting (YAML, summary, etc.)
-   **`environment-utils.ts`** - Environment and domain utilities
-   **`log-debugger.ts`** - Advanced log analysis for ECS services

### Checkers

Individual service checkers that can be used independently:

-   **`cloudformation-checker.ts`** - CloudFormation stack health
-   **`ecs-checker.ts`** - ECS services with advanced diagnostics
-   **`rds-checker.ts`** - RDS instances and clusters
-   **`simple-checkers.ts`** - S3, SQS, Lambda, Secrets Manager, CloudWatch, ACM
-   **`loadbalancer-checker.ts`** - ALB health and target diagnostics
-   **`endpoint-checker.ts`** - HTTP/HTTPS endpoint testing

## Features

### Advanced Diagnostics

-   **ECS Service Analysis**: Detects ECR permission issues, health check failures, database connectivity problems
-   **Log Analysis**: Automatically analyzes CloudWatch logs for error patterns
-   **Load Balancer Health**: Detailed target health analysis with specific recommendations
-   **Certificate Monitoring**: SSL certificate validation and expiry checking
-   **Endpoint Testing**: HTTP/HTTPS endpoint validation with domain mismatch detection

### Intelligent Recommendations

The system provides specific, actionable recommendations based on detected issues:

-   Database connectivity problems → Check DATABASE_URL and RDS security groups
-   Health check failures → Verify application startup and dependencies
-   ECR issues → Check task execution role permissions
-   Certificate mismatches → Use correct custom domains

### Flexible Output

-   **YAML Format**: Structured status data
-   **Summary Format**: Human-readable status with emojis and clear issue descriptions
-   **JSON Format**: Machine-readable output for integration
-   **Exit Codes**: Different exit codes for automation (0=healthy, 1=critical, 2=errors, 3=warnings, 4=failure)

## Usage

### Command Line

```bash
# Check development environment
./check-status.ts --env development

# Check production with summary output
./check-status.ts --env production --summary

# JSON output for automation
./check-status.ts --env staging --json

# Quiet mode (no progress messages)
./check-status.ts --env production --quiet
```

### Programmatic Usage

```typescript
import { AWSStatusChecker, StatusFormatters } from './status-checker';

const checker = new AWSStatusChecker('us-east-1', 'production');
const status = await checker.checkAll();

console.log(StatusFormatters.formatSummary(status));
```

### Individual Checkers

```typescript
import { ECSChecker, RDSChecker } from './status-checker';

// Check only ECS services
const ecsChecker = new ECSChecker('us-east-1', 'development');
const ecsResults = await ecsChecker.check();

// Check only RDS
const rdsChecker = new RDSChecker('us-east-1', 'development');
const rdsResults = await rdsChecker.check();
```

## Environment Detection

The system automatically detects relevant resources for each environment using naming conventions:

-   CloudFormation stacks: `*-{environment}-*` or `v3-backend-{environment}`
-   RDS instances: `*-{environment}-*` or `v3-backend-{environment}`
-   Load balancers: `*-{environment}-*` or `v3-backend-{environment}`
-   Log groups: `/v3-backend/{environment}/api`

## Domain Configuration

The system can dynamically read domain configuration from environment files:

```
infrastructure/config/environments/{environment}.ts
```

This allows for automatic domain detection and certificate validation.

## Extending the System

### Adding a New Checker

1. Create a new checker class in the `checkers/` directory
2. Implement the standard interface with a `check()` method returning `StatusResult[]`
3. Add the checker to `aws-status-checker.ts`
4. Export it in `index.ts`

### Adding New Diagnostics

The ECS checker demonstrates advanced diagnostics patterns that can be applied to other services:

-   Log analysis with pattern detection
-   Specific error categorization
-   Intelligent recommendation generation
-   Historical failure analysis

## Error Categories

-   **Critical**: System-breaking issues that prevent functionality
-   **Configuration**: Service configuration problems
-   **Efficiency**: Performance or optimization issues
-   **Healthy**: Services operating normally

## Exit Codes

-   `0`: All services healthy
-   `1`: System not functional (critical issues or endpoints down)
-   `2`: Errors detected but system functional
-   `3`: Warnings detected
-   `4`: Script execution failure
