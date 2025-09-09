# Stuck CloudFormation Stack Recovery

This document explains how to handle stuck CloudFormation stacks in the Balancer v3 Backend infrastructure.

## Common Issue: UPDATE_ROLLBACK_IN_PROGRESS

When a CloudFormation stack gets stuck in `UPDATE_ROLLBACK_IN_PROGRESS`, the usual cancellation methods don't work. This is a common AWS issue where the rollback process hangs on certain resources.

### Symptoms

-   CI/CD pipeline fails with health check errors
-   Stack shows `UPDATE_ROLLBACK_IN_PROGRESS` for extended periods (>30 minutes)
-   `CancelUpdateStack cannot be called from current stack status` errors

## Automated Solutions

### 1. GitHub Actions Workflow

Use the `Fix Stuck CloudFormation Stack` workflow:

1. Go to **Actions** tab in GitHub
2. Select **Fix Stuck CloudFormation Stack**
3. Click **Run workflow**
4. Choose your environment (dev/staging/prod)
5. Optionally specify a specific stack name

The workflow will:

-   Detect stuck stacks automatically
-   Identify stuck resources (ECS services, target groups, etc.)
-   Attempt to fix stuck resources
-   Continue rollback operations
-   Create GitHub issues if manual intervention is needed

### 2. Command Line Tools

#### Quick Fix (Recommended)

```bash
cd infrastructure
npm run fix-stuck-stack:dev
```

#### Dry Run (See what would be done)

```bash
cd infrastructure
npm run fix-stuck-stack:dev -- --dry-run
```

#### Fix Specific Stack

```bash
cd infrastructure
npm run fix-stuck-stack -- --environment development --stack-name v3-backend-development-compute
```

#### Force Delete (Last Resort)

```bash
cd infrastructure
npm run fix-stuck-stack:dev -- --force-delete
```

### 3. Enhanced Health Check

The health check now automatically handles stuck rollbacks:

```bash
cd infrastructure
npm run health-check:auto-fix
```

## Manual Recovery Steps

If automated solutions don't work, follow these steps:

### Step 1: Identify Stuck Resources

```bash
aws cloudformation describe-stack-events \
  --stack-name v3-backend-development-compute \
  --query 'StackEvents[?ResourceStatus==`UPDATE_ROLLBACK_IN_PROGRESS`]' \
  --output table
```

### Step 2: Continue Rollback

```bash
aws cloudformation continue-update-rollback \
  --stack-name v3-backend-development-compute
```

### Step 3: Skip Stuck Resources (if needed)

```bash
aws cloudformation continue-update-rollback \
  --stack-name v3-backend-development-compute \
  --resources-to-skip <ResourceLogicalId>
```

### Step 4: Manual Resource Cleanup

#### ECS Services

```bash
# Scale down to 0 tasks
aws ecs update-service \
  --cluster <cluster-name> \
  --service <service-name> \
  --desired-count 0
```

#### Target Groups

```bash
# Deregister all targets
aws elbv2 describe-target-health \
  --target-group-arn <target-group-arn>

aws elbv2 deregister-targets \
  --target-group-arn <target-group-arn> \
  --targets Id=<target-id>
```

#### Security Groups

```bash
# Remove inbound/outbound rules manually
aws ec2 revoke-security-group-ingress \
  --group-id <sg-id> \
  --protocol tcp \
  --port 80 \
  --cidr 0.0.0.0/0
```

## Prevention

### Best Practices

1. **Use gradual rollouts**: Deploy to dev → staging → prod
2. **Monitor deployments**: Use the infrastructure dashboard
3. **Keep deployments small**: Avoid large batch changes
4. **Test locally**: Use LocalStack for infrastructure testing
5. **Set up alerts**: Configure CloudWatch alarms for long-running operations

### Monitoring Commands

```bash
# Check all environments
npm run dashboard

# Monitor specific environment
npm run dashboard:dev:watch

# Check deployment status
npm run check-status:dev
```

## Recovery Workflow Diagram

```
┌─────────────────┐
│ Stack Stuck?    │
└─────┬───────────┘
      │
      ▼
┌─────────────────┐    ┌──────────────────┐
│ Run Auto-Fix    │───▶│ GitHub Workflow  │
│ npm run fix-... │    │ (Recommended)    │
└─────────────────┘    └──────────────────┘
      │
      ▼
┌─────────────────┐
│ Manual Steps    │
│ 1. Identify     │
│ 2. Continue     │
│ 3. Skip/Clean   │
└─────────────────┘
      │
      ▼
┌─────────────────┐
│ Stack Recovery  │
│ Complete        │
└─────────────────┘
```

## Common Stuck Resources

| Resource Type   | Common Causes                          | Fix Strategy              |
| --------------- | -------------------------------------- | ------------------------- |
| ECS Service     | Unhealthy tasks, deployment timeout    | Scale to 0 tasks          |
| Target Group    | Unhealthy targets, connection draining | Deregister targets        |
| Security Group  | Dependencies, attached resources       | Remove rules/dependencies |
| RDS Instance    | Long-running transactions, snapshots   | Wait or force restart     |
| Lambda Function | Concurrent executions, VPC config      | Check logs, retry         |

## Troubleshooting

### Issue: "No AWS credentials"

```bash
aws configure
# or
export AWS_PROFILE=your-profile
```

### Issue: "Region not found"

```bash
export AWS_REGION=ca-central-1
```

### Issue: "Stack not found"

```

```
