# DevOps Operations Manual

**Balancer V3 Backend Infrastructure**

## 📋 Table of Contents

-   [Quick Reference](#quick-reference)
-   [Daily Operations](#daily-operations)
-   [Deployment Workflows](#deployment-workflows)
-   [Environment Management](#environment-management)
-   [Troubleshooting](#troubleshooting)
-   [New Environment Setup](#new-environment-setup)
-   [Monitoring & Alerting](#monitoring--alerting)
-   [Emergency Procedures](#emergency-procedures)
-   [Best Practices](#best-practices)

---

## 🚀 Quick Reference

### Prerequisites

```bash
# Always use correct Node.js version
cd infrastructure && nvm use

# Verify AWS credentials
aws sts get-caller-identity

# Verify CDK bootstrap
npm run check-bootstrap
```

### Daily Health Check

```bash
npm run check-status:prod
npm run check-status:staging
npm run check-status:dev
```

### Emergency Commands

```bash
# Production issues
npm run fix-stuck-stack:prod -- --skip-unfixable
npm run monitor:prod:continuous
npm run diagnose-rollback:prod

# Development environment down
npm run fix-dev-rollback
npm run fix-stuck-stack:dev -- --skip-unfixable
```

---

## 📊 Daily Operations

### Morning Health Check Routine

```bash
# 1. Check all environments
npm run check-status:prod --summary
npm run check-status:staging --summary
npm run check-status:dev --summary

# 2. Review overnight alerts (if any)
npm run dashboard:prod

# 3. Check for stuck deployments
npm run diagnose-rollback:prod
npm run diagnose-rollback:staging
```

### Pre-Deployment Validation

```bash
# Always validate before deploying
npm run validate:prod
npm run validate:staging
npm run validate:dev
```

### Post-Deployment Monitoring

```bash
# Monitor deployment progress
npm run monitor:prod:continuous
# OR one-time check
npm run monitor:prod
```

---

## 🚚 Deployment Workflows

### GitHub Actions Deployment

The project uses **two deployment workflows** for different scenarios:

#### **1. Full Deployment (deploy.yml)**

-   **Purpose**: Complete infrastructure + application deployment
-   **Input**: Docker image tag (e.g., `latest`, `1.41.8-abc123def`)
-   **Use Cases**: Infrastructure changes, new environments
-   **Trigger**: Manual via GitHub Actions UI

#### **2. Code-Only Deployment (deploy-code.yml)**

-   **Purpose**: Fast application updates without infrastructure changes
-   **Input**: Uses latest images from ECR repository
-   **Use Cases**: Application code updates, hotfixes
-   **Trigger**: Can be configured for automatic branch deployments

**Manual Deployment via GitHub UI:**

1. Go to Actions tab
2. Select workflow:
    - "Deploy Infrastructure" (full deployment)
    - "Deploy Code Only" (application updates)
3. Choose environment and provide image tag (for full deployment)
4. Monitor deployment logs

### Local Deployment (Emergency)

#### **Full Infrastructure Deployment:**

**Development:**

```bash
cd infrastructure && nvm use
npm run validate:dev
npm run deploy:dev
npm run monitor:dev:continuous
```

**Staging:**

```bash
cd infrastructure && nvm use
npm run validate:staging
npm run deploy:staging
npm run monitor:staging:continuous
```

**Production (Requires approval):**

```bash
cd infrastructure && nvm use
npm run validate:prod
npm run deploy:prod
npm run monitor:prod:continuous
```

#### **Code-Only Deployment:**

**Development:**

```bash
cd infrastructure && nvm use
npm run deploy:dev:code-only
npm run monitor:dev:continuous
```

**Staging:**

```bash
cd infrastructure && nvm use
npm run deploy:staging:code-only
npm run monitor:staging:continuous
```

**Production:**

```bash
cd infrastructure && nvm use
npm run deploy:prod:code-only
npm run monitor:prod:continuous
```

### Docker Image Deployment

#### **Full Deployment with Specific Image:**

```bash
# Deploy infrastructure with specific image tag
export IMAGE_TAG="1.41.8-abc123def"
npm run deploy:prod
# OR via GitHub Actions with image tag input
```

#### **Code-Only Deployment:**

```bash
# Uses latest built image automatically
npm run deploy:prod:code-only
# OR via GitHub Actions deploy-code.yml workflow
```

---

## 🌍 Environment Management

### Environment Overview

| Environment     | Purpose             | Min Instances | Auto-Scaling | Monitoring    | Budget      |
| --------------- | ------------------- | ------------- | ------------ | ------------- | ----------- |
| **Development** | Feature development | 1             | 1-3          | Basic         | $50/month   |
| **Staging**     | QA/Testing          | 2             | 2-5          | Enhanced      | $200/month  |
| **Production**  | Live traffic        | 3             | 3-20         | Comprehensive | $2000/month |

### Environment-Specific Commands

**Development Environment:**

```bash
# Status & Health
npm run check-status:dev
npm run dashboard:dev

# Full Deployment
npm run validate:dev
npm run deploy:dev
npm run monitor:dev

# Code-Only Deployment (faster)
npm run deploy:dev:code-only

# Troubleshooting
npm run fix-dev-rollback
npm run fix-stuck-stack:dev
npm run diagnose-rollback:dev
```

**Staging Environment:**

```bash
# Status & Health
npm run check-status:staging
npm run dashboard:staging

# Full Deployment
npm run validate:staging
npm run deploy:staging
npm run monitor:staging:continuous

# Code-Only Deployment (faster)
npm run deploy:staging:code-only

# Troubleshooting
npm run fix-stuck-stack:staging
npm run diagnose-rollback:staging
```

**Production Environment:**

```bash
# Status & Health (Run multiple times daily)
npm run check-status:prod
npm run dashboard:prod

# Pre-deployment (ALWAYS required)
npm run validate:prod

# Full Deployment (Use GitHub Actions preferably)
npm run deploy:prod
npm run monitor:prod:continuous

# Code-Only Deployment (for application updates)
npm run deploy:prod:code-only

# Emergency response
npm run fix-stuck-stack:prod -- --skip-unfixable
npm run diagnose-rollback:prod
```

---

## 🔧 Troubleshooting

### Service Unavailable (503 Errors)

**Symptoms:** API returning 503, health checks failing

```bash
# 1. Quick diagnosis
npm run check-status:ENV

# 2. Check if services are scaled to 0
# If API shows 0/0 tasks, run recovery:
npm run fix-dev-rollback  # For development
# OR
npm run fix-stuck-stack:ENV -- --skip-unfixable

# 3. Monitor recovery
npm run monitor:ENV:continuous
```

### Stuck CloudFormation Stacks

**Symptoms:** Stack in `UPDATE_ROLLBACK_FAILED`, `UPDATE_IN_PROGRESS` for >30min

```bash
# 1. Identify stuck stacks
npm run fix-stuck-stack:ENV --dry-run

# 2. Fix stuck resources (safe to run)
npm run fix-stuck-stack:ENV -- --skip-unfixable

# 3. For in-progress operations blocking deployment
npm run fix-stuck-stack:ENV -- --delete-in-progress
```

### Failed Deployments

**Symptoms:** Circuit breaker triggered, services rolled back

```bash
# 1. Analyze what went wrong
npm run diagnose-rollback:ENV

# 2. Check current deployment state
npm run monitor:ENV

# 3. If auto-rollback didn't work
npm run fix-stuck-stack:ENV

# 4. Review logs for root cause
npm run logs:ENV  # If available
```

### Database Connection Issues

**Symptoms:** Tasks failing with database connection errors

```bash
# 1. Check database status
npm run check-status:ENV --summary

# 2. Verify secrets are accessible
aws secretsmanager get-secret-value --secret-id v3-backend/ENV/config

# 3. Check RDS instance status
aws rds describe-db-instances --db-instance-identifier v3-backend-ENV-database
```

### High Queue Depth

**Symptoms:** SQS alarms firing, background job queue backing up

```bash
# 1. Check queue status
npm run check-status:ENV

# 2. Investigate DLQ for failed jobs
npm run dlq:status:ENV
npm run dlq:dev peek  # Examine failed messages

# 3. Clear DLQ if messages are invalid/stale
npm run dlq:purge:ENV  # Fast AWS native purge (recommended)
# OR
npm run dlq:drain:ENV  # Slower message-by-message deletion

# 4. Scale up worker services if needed
aws ecs update-service --cluster v3-backend-ENV-cluster \
  --service v3-backend-ENV-worker-service --desired-count 3

# 5. Monitor queue drainage
npm run dlq:status:ENV
```

---

## 🆕 New Environment Setup

### Creating a New Environment

**1. Configuration Setup**

```bash
# Copy existing environment config
cp config/environments/staging.ts config/environments/newenv.ts

# Edit configuration for new environment
vim config/environments/newenv.ts
```

**2. Environment-Specific Changes**

-   Update `environment` field
-   Adjust resource allocations
-   Set appropriate domain names
-   Configure budget limits
-   Update tags

**3. Secrets Setup**

```bash
# Create environment secrets
npm run init-secrets:newenv

# Manually create secrets in AWS Secrets Manager:
# - v3-backend/newenv/config
# - v3-backend-newenv-db-credentials
```

**4. Initial Deployment**

```bash
# Bootstrap CDK (if needed)
npm run bootstrap

# Validate configuration
npm run validate:newenv

# Deploy infrastructure
npm run deploy:newenv

# Verify deployment
npm run check-status:newenv
npm run monitor:newenv
```

**5. DNS Setup**

-   Update Route53 hosted zone
-   Configure SSL certificates
-   Update load balancer targets

**6. Monitoring Setup**

```bash
# Set up dashboards
npm run dashboard:newenv

# Configure alerts (update CloudWatch alarms)
# Set up log forwarding
```

### Environment-Specific Networking

**Development:** Single AZ, minimal resources
**Staging:** Single AZ, production-like setup  
**Production:** Multi-AZ, full redundancy

### Domain Configuration

| Environment | Domain                       | SSL            |
| ----------- | ---------------------------- | -------------- |
| Development | `dev-api.hyperchonk.com`     | Let's Encrypt  |
| Staging     | `staging-api.hyperchonk.com` | Let's Encrypt  |
| Production  | `api.hyperchonk.com`         | Commercial SSL |

---

## 📈 Monitoring & Alerting

### Health Check Endpoints

```bash
# Application health
curl -I https://ENV-api.hyperchonk.com/health

# Deep health check
curl https://ENV-api.hyperchonk.com/health/deep

# GraphQL endpoint
curl -I https://ENV-api.hyperchonk.com/graphql
```

### Key Metrics to Monitor

**Service Health:**

-   Task count vs desired count
-   Task failure rate
-   Deployment success rate

**Application Performance:**

-   Response time (<2s production, <3s staging)
-   Error rate (<1% production, <5% staging)
-   Throughput (requests/second)

**Infrastructure Health:**

-   CPU utilization (<60% production)
-   Memory utilization (<70% production)
-   Database connections
-   Queue depth

### Alert Thresholds

**Critical Alerts (Immediate Response):**

-   Service down (0 running tasks)
-   Error rate >5%
-   Response time >5s
-   Database unavailable

**Warning Alerts (Monitor):**

-   Service degraded (tasks < desired)
-   Error rate >1%
-   High queue depth (>100 messages)
-   High resource utilization

### Monitoring Commands

```bash
# Real-time monitoring
npm run monitor:ENV:continuous

# One-time status check
npm run check-status:ENV

# Infrastructure dashboard
npm run dashboard:ENV --watch

# Detailed analysis
npm run diagnose-rollback:ENV

# DLQ monitoring and management
npm run dlq:status:ENV     # Check DLQ status
npm run dlq:ENV peek       # Examine failed messages
npm run dlq:purge:ENV      # Fast purge (recommended)
npm run dlq:drain:ENV      # Slow drain
```

---

## 🚨 Emergency Procedures

### Production Outage Response

**Severity 1: Complete service outage**

```bash
# 1. Immediate assessment (2 minutes)
npm run check-status:prod

# 2. If services are down, attempt auto-recovery (5 minutes)
npm run fix-stuck-stack:prod -- --skip-unfixable

# 3. Monitor recovery (ongoing)
npm run monitor:prod:continuous

# 4. If recovery fails, emergency rollback (10 minutes)
# Use GitHub Actions to deploy last known good version

# 5. Communicate status
# Update status page, notify stakeholders
```

**Severity 2: Degraded performance**

```bash
# 1. Assess impact
npm run check-status:prod --summary

# 2. Analyze root cause
npm run diagnose-rollback:prod

# 3. Scale up if needed
aws ecs update-service --cluster v3-backend-production-cluster \
  --service v3-backend-production-api-service --desired-count 5

# 4. Monitor improvement
npm run monitor:prod
```

### Rollback Procedures

**Automated Rollback (Preferred):**

-   Circuit breaker automatically triggers rollback
-   Monitor via `npm run monitor:ENV:continuous`

**Manual Rollback:**

```bash
# 1. Identify last good deployment
git log --oneline

# 2. Deploy previous version via GitHub Actions
# OR locally:
git checkout [LAST_GOOD_COMMIT]
npm run deploy:ENV

# 3. Monitor rollback
npm run monitor:ENV:continuous
```

### Database Emergency

**Database connection issues:**

```bash
# 1. Check RDS status
aws rds describe-db-instances --db-instance-identifier v3-backend-ENV-database

# 2. If RDS is healthy, check security groups and secrets
npm run check-status:ENV

# 3. Restart services to refresh connections
aws ecs update-service --cluster v3-backend-ENV-cluster \
  --service v3-backend-ENV-api-service --force-new-deployment
```

**Database performance issues:**

-   Enable Performance Insights
-   Review slow query logs
-   Consider read replica promotion for critical reads

---

## ✅ Best Practices

### Deployment Best Practices

**1. Always Use Pre-Deployment Validation**

```bash
npm run validate:ENV
```

**2. Deploy During Off-Peak Hours**

-   Development: Anytime
-   Staging: Avoid QA testing hours
-   Production: 2-6 AM EST (low traffic)

**3. Monitor Deployments Actively**

```bash
npm run monitor:ENV:continuous
```

**4. Use GitHub Actions for Production**

-   Provides audit trail
-   Enforces review process
-   Consistent deployment environment

### Security Best Practices

**1. Secrets Management**

-   Never commit secrets to git
-   Use AWS Secrets Manager for all sensitive data
-   Rotate secrets regularly

**2. Access Control**

-   Use least-privilege IAM policies
-   Enable MFA for AWS console access
-   Audit access logs regularly

**3. Network Security**

-   Services in private subnets only
-   WAF enabled for production
-   VPC Flow Logs enabled

### Operational Best Practices

**1. Documentation**

-   Update this manual when procedures change
-   Document all environment-specific configurations
-   Maintain runbooks for common issues

**2. Testing**

-   Test deployment procedures in staging first
-   Validate rollback procedures regularly
-   Practice emergency response scenarios

**3. Monitoring**

-   Set up comprehensive alerting
-   Monitor business metrics, not just infrastructure
-   Regular review of alert thresholds

### Cost Optimization

**Development:**

-   Scale down during off-hours (manually)
-   Use smaller instance types
-   Shorter log retention

**Staging:**

-   Schedule scaling for business hours
-   Share resources when possible
-   Moderate backup retention

**Production:**

-   Right-size instances based on metrics
-   Use reserved instances for baseline capacity
-   Implement auto-scaling effectively

---

## 📞 Support & Escalation

### Contact Information

**On-Call DevOps Engineer:** [Contact details]
**Platform Team Lead:** [Contact details]
**AWS Support:** [Support plan details]

### Escalation Criteria

**Immediate Escalation:**

-   Production complete outage >15 minutes
-   Data corruption or loss
-   Security incident

**Normal Escalation:**

-   Deployment failures in production
-   Persistent performance degradation
-   Infrastructure cost anomalies

### Documentation Links

-   [AWS Console](https://console.aws.amazon.com)
-   [GitHub Repository](https://github.com/hyperchonk/backend)
-   [Secrets Reference](./secrets-reference.md)
-   [Log Tailing Guide](./LOG_TAILING_GUIDE.md)
-   [Stack Recovery Guide](./STUCK_STACK_RECOVERY.md)

---

## 🔄 Change Log

**v1.0.0** - Initial DevOps manual

-   Basic deployment procedures
-   Environment management
-   Troubleshooting guides
-   Emergency procedures

---

_Last Updated: 2025-07-14_
_Next Review: 2025-10-14_
