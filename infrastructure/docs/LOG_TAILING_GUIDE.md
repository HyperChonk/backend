# CloudWatch Log Tailing Guide

This guide explains how to use the live log tailing script to debug deployment issues and monitor your services in real-time.

## Overview

The log tailing script automatically discovers and streams logs from all CloudWatch log groups in your environment, including:

-   **API Service** (`/v3-backend/{env}/api`) - Your main application logs
-   **Background Processor** (`/v3-backend/{env}/background-processor`) - Background job processing logs
-   **WAF Logs** (`/v3-backend/{env}/waf`) - Web Application Firewall logs
-   **VPC Flow Logs** (`/aws/vpc/flowlogs/{env}`) - Network traffic logs
-   **Lambda Functions** (`/aws/lambda/v3-backend-{env}-*`) - Serverless function logs
-   **Other Services** - Any other log groups matching your environment

## Quick Start

### 1. Install Dependencies

```bash
cd infrastructure
npm install
```

### 2. Basic Usage

```bash
# Show recent logs from development environment
./scripts/tail-logs.sh

# Live tail development logs (press Ctrl+C to stop)
./scripts/tail-logs.sh dev --follow

# Show recent logs from production
./scripts/tail-logs.sh prod
```

## Command Reference

### Using the Shell Script (Recommended)

```bash
./scripts/tail-logs.sh [environment] [options]
```

**Environments:**

-   `dev` or `development` (default)
-   `staging`
-   `prod` or `production`

**Options:**

-   `-f, --follow` - Live tail logs (continuous streaming)
-   `-s, --services <list>` - Filter by services (api,background,waf,vpc,lambda)
-   `--filter <pattern>` - CloudWatch filter pattern
-   `-n, --lines <number>` - Number of lines/minutes of history (default: 20)
-   `--start-time <time>` - Start time (ISO string or relative like '2h ago')
-   `-q, --quiet` - Suppress discovery messages
-   `--json` - Output in JSON format
-   `--no-colors` - Disable colored output

### Using NPM Scripts

```bash
# Basic log viewing
npm run logs                    # development logs
npm run logs:staging           # staging logs
npm run logs:prod             # production logs

# Live tailing
npm run logs:follow            # live tail development
npm run logs:dev:follow        # live tail development
npm run logs:staging:follow    # live tail staging
npm run logs:prod:follow       # live tail production

# Service-specific
npm run logs:api               # API service only
npm run logs:api:follow        # live tail API service
```

### Direct TypeScript Execution

```bash
npx ts-node scripts/live-tail-logs.ts [options]
```

## Usage Examples

### Debugging Deployment Issues

When you have a stuck compute deployment like you experienced:

```bash
# Live tail all services during deployment
./scripts/tail-logs.sh dev --follow

# Focus on API service only (most likely to show startup issues)
./scripts/tail-logs.sh dev --follow --services api

# Look for errors in the last hour
./scripts/tail-logs.sh dev --filter "ERROR" --start-time "1h ago"

# Check background processor separately
./scripts/tail-logs.sh dev --follow --services background
```

### Production Monitoring

```bash
# Monitor production errors in real-time
./scripts/tail-logs.sh prod --follow --filter "ERROR"

# Check WAF blocked requests
./scripts/tail-logs.sh prod --follow --services waf

# Monitor all production services with minimal noise
./scripts/tail-logs.sh prod --follow --quiet
```

### Historical Log Analysis

```bash
# Check logs from specific time period
./scripts/tail-logs.sh staging --start-time "2024-01-15T10:00:00Z" --lines 100

# Get recent deployment logs
./scripts/tail-logs.sh prod --start-time "30m ago" --lines 50

# Export logs to JSON for analysis
./scripts/tail-logs.sh dev --json --lines 200 > debug-logs.json
```

### Service-Specific Debugging

```bash
# API service startup issues
./scripts/tail-logs.sh dev --services api --follow

# Background job processing
./scripts/tail-logs.sh prod --services background --filter "job"

# Network/security issues
./scripts/tail-logs.sh prod --services vpc,waf --follow
```

## Log Output Format

### Standard Format

```
2024-01-15T14:30:25.123Z [api       ] Starting application server on port 4000
2024-01-15T14:30:25.456Z [background] Processing sync job for POLYGON chain
2024-01-15T14:30:25.789Z [waf       ] Blocked request from IP 192.168.1.100
```

### JSON Format

```json
{
    "timestamp": "2024-01-15T14:30:25.123Z",
    "service": "api",
    "logGroup": "/v3-backend/development/api",
    "message": "Starting application server on port 4000"
}
```

## Troubleshooting

### Common Issues

**1. "ts-node: command not found"**

```bash
cd infrastructure
npm install
# Then try again
```

**2. "No log groups found"**

-   Check that your environment exists and has been deployed
-   Verify AWS credentials are configured
-   Ensure the environment name is correct (development, staging, production)

**3. "Failed to get logs from log group"**

-   Check AWS IAM permissions for CloudWatch Logs
-   Verify the log group exists in AWS console
-   Ensure you're in the correct AWS region

**4. "AccessDenied" errors**

-   Your AWS credentials need CloudWatch Logs read permissions
-   Add the `logs:DescribeLogGroups`, `logs:DescribeLogStreams`, and `logs:FilterLogEvents` permissions

### Performance Tips

**For High-Volume Environments:**

-   Use `--services` to filter specific services
-   Use `--filter` to match specific patterns
-   Use `--quiet` to reduce output noise
-   Consider shorter polling intervals for production

**For Development:**

-   Use `--follow` to see issues as they happen
-   Focus on `--services api` for application startup issues
-   Use `--start-time "5m ago"` to see recent context

## Integration with Deployment Workflow

### During Deployment Monitoring

1. **Start the log tailer before deployment:**

    ```bash
    ./scripts/tail-logs.sh dev --follow --services api,background
    ```

2. **In another terminal, run your deployment:**

    ```bash
    npm run deploy:dev
    ```

3. **Watch for issues in real-time:**
    - Container startup errors
    - Health check failures
    - Database connection issues
    - Resource exhaustion (OOM, CPU)

### Common Deployment Issue Patterns

**Container Startup Failures:**

```
Failed to retrieve logs for task arn:aws:ecs:...
Task stopped before logging started
```

→ Usually resource constraints or image pull issues

**Health Check Failures:**

```
Health check timeout
Application not responding on /health
```

→ Application taking too long to start or crashes during startup

**Database Connection Issues:**

```
ECONNREFUSED
database connection failed
DATABASE_URL not accessible
```

→ Secrets, networking, or RDS availability issues

## Advanced Features

### Custom Log Group Patterns

```bash
# Include custom log groups
./scripts/tail-logs.sh dev --log-group-pattern "/custom/service/*"

# Multiple environments (not recommended for production)
./scripts/tail-logs.sh dev --log-group-pattern "/v3-backend/*"
```

### Filtering Examples

```bash
# Show only specific log levels
./scripts/tail-logs.sh prod --filter "ERROR OR WARN"

# Database-related logs
./scripts/tail-logs.sh dev --filter "database OR prisma OR connection"

# Performance monitoring
./scripts/tail-logs.sh prod --filter "duration OR slow OR timeout"

# Specific user or session
./scripts/tail-logs.sh prod --filter "user:12345"
```

### Time Range Queries

```bash
# Last 2 hours
./scripts/tail-logs.sh prod --start-time "2h ago" --lines 100

# Specific incident time
./scripts/tail-logs.sh prod --start-time "2024-01-15T10:30:00Z" --lines 50

# Since deployment started
./scripts/tail-logs.sh staging --start-time "30m ago" --follow
```

This log tailing script should significantly help with debugging deployment timeouts and other issues by giving you real-time visibility into what's happening across all your services!
