# Secrets Management Guide

This guide explains how to set up the required secrets for the Balancer V3 Backend infrastructure.

## Overview

The application uses AWS Secrets Manager to store sensitive configuration values. All secrets are stored in a single JSON secret per environment, making it easier to manage and deploy.

## Secret Structure

### Secret Name Pattern

```
v3-backend/{environment}/config
```

Where `{environment}` is one of: `development`, `staging`, `production`

### Required JSON Structure

Create a secret with the following JSON structure in AWS Secrets Manager:

```json
{
    "DATABASE_URL": "postgresql://username:password@host:5432/database_name",
    "ADMIN_API_KEY": "your-admin-api-key-here",
    "SANITY_API_TOKEN": "your-sanity-cms-token",
    "SENTRY_DSN": "https://your-sentry-dsn@sentry.io/project-id",
    "SENTRY_AUTH_TOKEN": "your-sentry-auth-token",
    "RPC_URL_TEMPLATE": "https://rpc.ankr.com/${network}/${apiKey}",
    "RPC_API_KEY": "your-rpc-provider-api-key",
    "THEGRAPH_API_KEY_FANTOM": "your-thegraph-fantom-api-key",
    "THEGRAPH_API_KEY_BALANCER": "your-thegraph-balancer-api-key",
    "GRAFANA_CLOUD_LOKI_ENDPOINT": "https://logs-prod-us-central1.grafana.net/loki/api/v1/push",
    "GRAFANA_CLOUD_USER_ID": "your-grafana-cloud-user-id",
    "GRAFANA_CLOUD_API_KEY": "your-grafana-cloud-api-key"
}
```

## Secret Descriptions

### Core Application Secrets

| Secret Key      | Description                  | Required | Example                               |
| --------------- | ---------------------------- | -------- | ------------------------------------- |
| `DATABASE_URL`  | PostgreSQL connection string | ✅       | `postgresql://user:pass@host:5432/db` |
| `ADMIN_API_KEY` | API key for admin operations | ✅       | `admin-key-123`                       |

### External Service Integration

| Secret Key                  | Description                             | Required | Notes                             |
| --------------------------- | --------------------------------------- | -------- | --------------------------------- |
| `SANITY_API_TOKEN`          | Sanity CMS API token                    | ✅       | Used for content management       |
| `RPC_URL_TEMPLATE`          | RPC URL template with placeholders      | ✅       | For blockchain RPC configuration  |
| `RPC_API_KEY`               | RPC provider API key                    | ✅       | For blockchain data access        |
| `THEGRAPH_API_KEY_FANTOM`   | The Graph API key for Fantom network    | ✅       | Network-specific subgraph access  |
| `THEGRAPH_API_KEY_BALANCER` | The Graph API key for Balancer protocol | ✅       | Protocol-specific subgraph access |

### Monitoring & Observability

| Secret Key                    | Description                     | Required | Notes                |
| ----------------------------- | ------------------------------- | -------- | -------------------- |
| `SENTRY_DSN`                  | Sentry error tracking DSN       | ✅       | For error monitoring |
| `SENTRY_AUTH_TOKEN`           | Sentry authentication token     | ✅       | For release tracking |
| `GRAFANA_CLOUD_LOKI_ENDPOINT` | Grafana Cloud Loki endpoint URL | ✅       | For log forwarding   |
| `GRAFANA_CLOUD_USER_ID`       | Grafana Cloud user ID           | ✅       | For authentication   |
| `GRAFANA_CLOUD_API_KEY`       | Grafana Cloud API key           | ✅       | For authentication   |

## Setup Instructions

### 1. Development Environment

For local development and the development AWS environment:

```bash
# Create the secret using AWS CLI
aws secretsmanager create-secret \
  --name "v3-backend/development/config" \
  --description "Configuration secrets for Balancer V3 Backend development environment" \
  --secret-string file://secrets-development.json
```

### 2. Staging Environment

```bash
aws secretsmanager create-secret \
  --name "v3-backend/staging/config" \
  --description "Configuration secrets for Balancer V3 Backend staging environment" \
  --secret-string file://secrets-staging.json
```

### 3. Production Environment

```bash
aws secretsmanager create-secret \
  --name "v3-backend/production/config" \
  --description "Configuration secrets for Balancer V3 Backend production environment" \
  --secret-string file://secrets-production.json
```

### 4. Using AWS Console

1. Navigate to AWS Secrets Manager in your AWS Console
2. Click "Store a new secret"
3. Select "Other type of secret"
4. Choose "Plaintext" and paste the JSON structure above
5. Name the secret using the pattern: `v3-backend/{environment}/config`
6. Add description and configure rotation if needed
7. Review and create the secret

## Environment-Specific Values

### Development

-   Use development/test API keys where possible
-   Database URL should point to your development RDS instance
-   Grafana Cloud can use the same credentials as other environments
-   Sentry should use a development project

### Staging

-   Use staging-specific API keys
-   Database URL should point to staging RDS instance
-   Consider using the same monitoring services as production for testing

### Production

-   Use production API keys with appropriate rate limits
-   Database URL should point to production RDS instance
-   Ensure all monitoring and logging services are properly configured
-   Enable secret rotation for production secrets

## Secret Rotation

### Automated Rotation

For production environments, consider enabling automatic secret rotation:

```bash
aws secretsmanager rotate-secret \
  --secret-id "v3-backend/production/config" \
  --rotation-lambda-arn "arn:aws:lambda:region:account:function:SecretsManagerRotationFunction"
```

### Manual Rotation

To manually update secrets:

```bash
aws secretsmanager update-secret \
  --secret-id "v3-backend/{environment}/config" \
  --secret-string file://updated-secrets.json
```

## Security Best Practices

1. **Least Privilege**: Only grant access to secrets to resources that need them
2. **Environment Separation**: Never use production secrets in non-production environments
3. **Regular Rotation**: Rotate secrets regularly, especially for production
4. **Audit Access**: Monitor who accesses secrets using CloudTrail
5. **Encryption**: Secrets are encrypted at rest and in transit by default

## Troubleshooting

### Common Issues

#### Secret Not Found

```
Error: Required SSM parameter not found: /v3-backend/development/config
```

**Solution**: Ensure the secret exists with the correct name pattern

#### Permission Denied

```
Error: User: arn:aws:iam::account:user/username is not authorized to perform: secretsmanager:GetSecretValue
```

**Solution**: Add the required IAM permissions:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
            "Resource": "arn:aws:secretsmanager:*:*:secret:v3-backend/*"
        }
    ]
}
```

#### Invalid JSON Format

**Solution**: Validate your JSON structure using a JSON validator before uploading

### Validation Script

Use this script to validate your secrets structure:

```bash
#!/bin/bash
# validate-secrets.sh

ENVIRONMENT=${1:-development}
SECRET_NAME="v3-backend/${ENVIRONMENT}/config"

echo "Validating secrets for environment: $ENVIRONMENT"

# Get secret value
SECRET_JSON=$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --query SecretString --output text 2>/dev/null)

if [ $? -ne 0 ]; then
  echo "❌ Secret not found: $SECRET_NAME"
  exit 1
fi

# Check required keys
REQUIRED_KEYS=("DATABASE_URL" "ADMIN_API_KEY" "SANITY_API_TOKEN" "SENTRY_DSN")

for key in "${REQUIRED_KEYS[@]}"; do
  if echo "$SECRET_JSON" | jq -e ".${key}" > /dev/null; then
    echo "✅ $key: Present"
  else
    echo "❌ $key: Missing"
  fi
done

echo "Validation complete"
```

## Need Help?

-   Check the [Infrastructure README](infrastructure/README.md) for deployment-specific information
-   Review AWS Secrets Manager documentation for advanced configuration
-   Contact the platform team for production secret management
