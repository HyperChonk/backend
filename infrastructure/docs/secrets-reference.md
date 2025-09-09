# 🔐 AWS Secrets Manager Configuration Reference

This document outlines all the required secrets for the Balancer v3 Backend deployment in AWS Secrets Manager.

## 📍 Secret Location

**Secret Name**: `v3-backend/{environment}/config`

-   Development: `v3-backend/development/config`
-   Staging: `v3-backend/staging/config`
-   Production: `v3-backend/production/config`

## 🗝️ Required Secret Keys

### **Core Application Configuration**

| Key                | Required   | Description                       | Example Value                                |
| ------------------ | ---------- | --------------------------------- | -------------------------------------------- |
| `DATABASE_URL`     | ✅ **YES** | PostgreSQL connection string      | `postgresql://user:pass@host:5432/dbname`    |
| `PORT`             | ✅ **YES** | Application server port           | `4000`                                       |
| `NODE_ENV`         | ✅ **YES** | Node.js environment               | `development`, `staging`, `production`       |
| `DEFAULT_CHAIN_ID` | ✅ **YES** | Default blockchain chain ID       | `250` (Fantom), `1` (Mainnet)                |
| `DEPLOYMENT_ENV`   | ✅ **YES** | Deployment environment identifier | `development`, `staging`, `production`       |
| `ADMIN_API_KEY`    | ✅ **YES** | Admin API authentication key      | `secure-random-string-change-me`             |
| `PROTOCOL`         | ✅ **YES** | Protocol identifier               | `balancer` (dev), `beethoven` (staging/prod) |

### **External API Keys** _(Optional but recommended)_

| Key                         | Required        | Description                                             | Provider                                                         |
| --------------------------- | --------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `RPC_URL_TEMPLATE`          | 🔶 **Optional** | RPC URL template with ${network}/${apiKey} placeholders | Various providers                                                |
| `RPC_API_KEY`               | 🔶 **Optional** | RPC provider API key                                    | [Ankr](https://ankr.com), [Alchemy](https://alchemy.com), others |
| `COINGECKO_API_KEY`         | 🔶 **Optional** | CoinGecko price data API key                            | [CoinGecko](https://coingecko.com)                               |
| `THEGRAPH_API_KEY_FANTOM`   | 🔶 **Optional** | The Graph protocol API key for Fantom                   | [The Graph](https://thegraph.com)                                |
| `THEGRAPH_API_KEY_BALANCER` | 🔶 **Optional** | The Graph protocol API key for Balancer                 | [The Graph](https://thegraph.com)                                |
| `SATSUMA_API_KEY`           | 🔶 **Optional** | Satsuma subgraph hosting API key                        | [Satsuma](https://satsuma.xyz)                                   |
| `SANITY_API_TOKEN`          | 🔶 **Optional** | Sanity CMS API token                                    | [Sanity](https://sanity.io)                                      |

### **Monitoring & Error Tracking**

| Key                           | Required        | Description                  | Example Value                          |
| ----------------------------- | --------------- | ---------------------------- | -------------------------------------- |
| `SENTRY_DSN`                  | 🔶 **Optional** | Sentry error tracking DSN    | `https://xxx@xxx.ingest.sentry.io/xxx` |
| `SENTRY_AUTH_TOKEN`           | 🔶 **Optional** | Sentry authentication token  | `sntrys_xxx`                           |
| `SENTRY_TRACES_SAMPLE_RATE`   | 🔶 **Optional** | Sentry trace sampling rate   | `1.0` (prod), `0.1` (dev)              |
| `SENTRY_PROFILES_SAMPLE_RATE` | 🔶 **Optional** | Sentry profile sampling rate | `1.0` (prod), `0.1` (dev)              |

### **Grafana Cloud Log Forwarding** _(Optional)_

| Key                           | Required        | Description                      | Example Value                                                |
| ----------------------------- | --------------- | -------------------------------- | ------------------------------------------------------------ |
| `GRAFANA_CLOUD_LOKI_ENDPOINT` | 🔶 **Optional** | Grafana Cloud Loki push endpoint | `https://logs-prod-us-central1.grafana.net/loki/api/v1/push` |
| `GRAFANA_CLOUD_USER_ID`       | 🔶 **Optional** | Grafana Cloud user ID            | `123456`                                                     |
| `GRAFANA_CLOUD_API_KEY`       | 🔶 **Optional** | Grafana Cloud API key            | `glc_xxx...`                                                 |

### **AWS Configuration** _(Auto-populated)_

| Key          | Required   | Description           | Auto-Set                         |
| ------------ | ---------- | --------------------- | -------------------------------- |
| `AWS_REGION` | ✅ **YES** | AWS deployment region | ✅ Auto-set to deployment region |

> **📝 Note**: SQS queue URLs (`SQS_BACKGROUND_JOB_QUEUE_URL`, `SQS_DATA_REFRESH_QUEUE_URL`, `SQS_NOTIFICATION_QUEUE_URL`) are now passed directly as environment variables during ECS deployment and are no longer needed in secrets.

### **Feature Flags & Toggles**

| Key          | Required   | Description                        | Default Value                        |
| ------------ | ---------- | ---------------------------------- | ------------------------------------ |
| `WORKER`     | ✅ **YES** | Enable background worker processes | `false`                              |
| `AWS_ALERTS` | ✅ **YES** | Enable AWS CloudWatch alerts       | `true` (prod), `false` (dev/staging) |
| `SCHEDULER`  | ✅ **YES** | Enable scheduled job processing    | `false`                              |

## 🛠️ How to Set Secrets

### **1. Using AWS Console**

1. Navigate to **AWS Secrets Manager** in your target region
2. Find the secret: `v3-backend/{environment}/config`
3. Edit the secret as **Plain text**
4. Paste the JSON with all required keys

### **2. Using AWS CLI**

```bash
# Update existing secret
aws secretsmanager update-secret \
  --secret-id "v3-backend/development/config" \
  --secret-string file://secret-values.json \
  --region us-east-1
```

### **3. Using the Initialization Script**

```bash
# From project root
cd infrastructure
ENVIRONMENT=development AWS_REGION=us-east-1 ./scripts/init-secrets.sh --update
```

## 📋 Secret Template

Copy this template and fill in your values:

```json
{
    "DATABASE_URL": "postgresql://user:password@host:5432/database",
    "PORT": "4000",
    "NODE_ENV": "development",
    "DEFAULT_CHAIN_ID": "250",
    "DEPLOYMENT_ENV": "development",
    "ADMIN_API_KEY": "your-secure-admin-key-here",
    "PROTOCOL": "balancer",
    "RPC_URL_TEMPLATE": "https://rpc.ankr.com/${network}/${apiKey}",
    "RPC_API_KEY": "your-rpc-provider-key-or-empty-string",
    "COINGECKO_API_KEY": "your-coingecko-key-or-empty-string",
    "THEGRAPH_API_KEY_FANTOM": "your-thegraph-fantom-key-or-empty-string",
    "THEGRAPH_API_KEY_BALANCER": "your-thegraph-balancer-key-or-empty-string",
    "SANITY_API_TOKEN": "your-sanity-token-or-empty-string",
    "SENTRY_DSN": "your-sentry-dsn-or-empty-string",
    "SENTRY_AUTH_TOKEN": "your-sentry-auth-token-or-empty-string",
    "SENTRY_TRACES_SAMPLE_RATE": "0.1",
    "SENTRY_PROFILES_SAMPLE_RATE": "0.1",
    "AWS_REGION": "us-east-1",
    "WORKER": "false",
    "AWS_ALERTS": "false",
    "SCHEDULER": "false",
    "GRAFANA_CLOUD_LOKI_ENDPOINT": "",
    "GRAFANA_CLOUD_USER_ID": "",
    "GRAFANA_CLOUD_API_KEY": ""
}
```

## ⚠️ Important Notes

### **Security**

-   **Never commit secrets to Git repositories**
-   **Use environment-specific values** (especially for production)
-   **Rotate API keys regularly** (especially `ADMIN_API_KEY`)
-   **Use empty strings `""` for optional keys** you don't need

### **Deployment**

-   **SQS queue URLs** are automatically populated during CDK deployment
-   **AWS_REGION** should match your deployment region
-   **Database URL** must be accessible from your ECS tasks

### **Environment Differences**

-   **Development**: Uses `PROTOCOL: "balancer"`, relaxed Sentry sampling
-   **Staging**: Uses `PROTOCOL: "beethoven"`, moderate monitoring
-   **Production**: Uses `PROTOCOL: "beethoven"`, full monitoring, alerts enabled

## 🔍 Troubleshooting

### **Secret Not Found Error**

```bash
# Verify secret exists
aws secretsmanager describe-secret --secret-id "v3-backend/development/config"

# Create if missing
./infrastructure/scripts/init-secrets.sh
```

### **Invalid JSON Error**

-   Validate your JSON using a tool like [jsonlint.com](https://jsonlint.com)
-   Ensure all strings are properly quoted
-   Check for trailing commas

### **ECS Task Permission Errors**

-   Verify the ECS task role has `secretsmanager:GetSecretValue` permission
-   Check the secret ARN matches the policy in the secrets stack

---

**📚 Related Documentation:**

-   [AWS Secrets Manager User Guide](https://docs.aws.amazon.com/secretsmanager/latest/userguide/)
-   [ECS Task Definitions with Secrets](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar.html)
