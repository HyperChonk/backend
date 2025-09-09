#!/bin/bash

# Initialize AWS Secrets Manager secrets for Balancer v3 Backend
# This script creates the necessary secrets if they don't exist

set -e

ENVIRONMENT=${ENVIRONMENT:-development}
REGION=${AWS_REGION:-us-east-1}

SECRET_NAME="v3-backend/${ENVIRONMENT}/config"

echo "🔐 Initializing secrets for environment: $ENVIRONMENT"
echo "📍 Region: $REGION"
echo "🏷️  Secret name: $SECRET_NAME"

# Generate cryptographically secure random API key
generate_secure_api_key() {
    # Generate 32 bytes of random data and encode as base64, then remove padding and special chars
    openssl rand -base64 32 | tr -d "=+/" | cut -c1-32
}

# Check if secret exists and is accessible (not deleted)
SECRET_STATUS=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" --query 'DeletedDate' --output text 2>/dev/null || echo "NOT_FOUND")

if [ "$SECRET_STATUS" = "NOT_FOUND" ]; then
    echo "🔍 Secret $SECRET_NAME does not exist, will create it"
    SECRET_EXISTS=false
elif [ "$SECRET_STATUS" != "None" ] && [ "$SECRET_STATUS" != "" ]; then
    echo "🗑️  Secret $SECRET_NAME is deleted (DeletedDate: $SECRET_STATUS), will recreate it"
    SECRET_EXISTS=false
    
    # Try to restore the secret first, if that fails we'll create a new one
    echo "🔄 Attempting to restore deleted secret..."
    if aws secretsmanager restore-secret --secret-id "$SECRET_NAME" --region "$REGION" >/dev/null 2>&1; then
        echo "✅ Secret restored successfully"
        SECRET_EXISTS=true
    else
        echo "❌ Failed to restore secret, will create a new one"
        SECRET_EXISTS=false
    fi
else
    # Try to actually access the secret value to confirm it's truly accessible
    if aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --region "$REGION" >/dev/null 2>&1; then
        echo "✅ Secret $SECRET_NAME already exists and is accessible"
        SECRET_EXISTS=true
    else
        echo "⚠️  Secret $SECRET_NAME exists but is not accessible, will recreate it"
        SECRET_EXISTS=false
    fi
fi

if [ "$SECRET_EXISTS" = true ]; then
    
    # Optionally update the secret with current values
    if [ "$1" = "--update" ]; then
        echo "🔄 Updating existing secret..."
        
        # Generate new secure API key if current one is weak
        SECURE_API_KEY=$(generate_secure_api_key)
        
        # Get current secret and pipe directly to Python (no temp files)
        aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --region "$REGION" --query SecretString --output text | python3 -c "
import json
import sys
import os

# Read current secret from stdin
current_secret_json = sys.stdin.read().strip()
current = json.loads(current_secret_json)

# Get environment variables
environment = os.environ.get('ENVIRONMENT', 'development')
region = os.environ.get('REGION', 'us-east-1')
secure_api_key = os.environ.get('SECURE_API_KEY', '')

# Check if current ADMIN_API_KEY is weak (contains predictable pattern)
current_api_key = current.get('ADMIN_API_KEY', '')
if 'change-me' in current_api_key or 'admin-key' in current_api_key or len(current_api_key) < 16:
    use_api_key = secure_api_key
    print('🔒 Generating new secure ADMIN_API_KEY (current key appears weak)', file=sys.stderr)
else:
    use_api_key = current_api_key
    print('✅ Keeping existing secure ADMIN_API_KEY', file=sys.stderr)

template = {
    'PORT': '4000',
    'WORKER_PORT': '4001',
    'NODE_ENV': environment,
    'DEFAULT_CHAIN_ID': '250',
    'DEPLOYMENT_ENV': environment,
    'ADMIN_API_KEY': use_api_key,
    'PROTOCOL': 'balancer' if environment == 'development' else 'beethoven',
    'DRPC_API_KEY': current.get('DRPC_API_KEY', ''),
    'DRPC_BEETS_API_KEY': current.get('DRPC_BEETS_API_KEY', ''),
    'COINGECKO_API_KEY': current.get('COINGECKO_API_KEY', ''),
    'THEGRAPH_API_KEY_FANTOM': current.get('THEGRAPH_API_KEY_FANTOM', ''),
    'THEGRAPH_API_KEY_BALANCER': current.get('THEGRAPH_API_KEY_BALANCER', ''),
    'SATSUMA_API_KEY': current.get('SATSUMA_API_KEY', ''),
    'SANITY_API_TOKEN': current.get('SANITY_API_TOKEN', ''),
    'SENTRY_DSN': current.get('SENTRY_DSN', ''),
    'SENTRY_AUTH_TOKEN': current.get('SENTRY_AUTH_TOKEN', ''),
    'SENTRY_TRACES_SAMPLE_RATE': '1.0' if environment == 'production' else '0.1',
    'SENTRY_PROFILES_SAMPLE_RATE': '1.0' if environment == 'production' else '0.1',
    'AWS_REGION': region,
    'WORKER': 'false',
    'AWS_ALERTS': 'true' if environment == 'production' else 'false',
    'SCHEDULER': 'false',
    # Grafana Cloud log forwarding credentials
    'GRAFANA_CLOUD_LOKI_ENDPOINT': current.get('GRAFANA_CLOUD_LOKI_ENDPOINT', ''),
    'GRAFANA_CLOUD_USER_ID': current.get('GRAFANA_CLOUD_USER_ID', ''),
    'GRAFANA_CLOUD_API_KEY': current.get('GRAFANA_CLOUD_API_KEY', '')
}

print(json.dumps(template, indent=2))
" | ENVIRONMENT="$ENVIRONMENT" REGION="$REGION" SECURE_API_KEY="$SECURE_API_KEY" aws secretsmanager update-secret \
            --secret-id "$SECRET_NAME" \
            --secret-string file:///dev/stdin \
            --region "$REGION" > /dev/null
            
        echo "✅ Secret updated successfully"
    fi
else
    echo "🔧 Creating new secret..."
    
    # Generate secure API key for new secret
    SECURE_API_KEY=$(generate_secure_api_key)
    echo "🔒 Generated secure ADMIN_API_KEY for new secret"
    
    # Create the secret with default values
    cat > /tmp/secret_value.json << EOF
{
  "PORT": "4000",
  "WORKER_PORT": "4001",
  "NODE_ENV": "$ENVIRONMENT",
  "DEFAULT_CHAIN_ID": "250",
  "DEPLOYMENT_ENV": "$ENVIRONMENT",
  "ADMIN_API_KEY": "$SECURE_API_KEY",
  "PROTOCOL": "$([ "$ENVIRONMENT" = "development" ] && echo "balancer" || echo "beethoven")",
  "DRPC_API_KEY": "",
  "DRPC_BEETS_API_KEY": "",
  "COINGECKO_API_KEY": "",
  "THEGRAPH_API_KEY_FANTOM": "",
  "THEGRAPH_API_KEY_BALANCER": "",
  "SATSUMA_API_KEY": "",
  "SANITY_API_TOKEN": "",
  "SENTRY_DSN": "",
  "SENTRY_AUTH_TOKEN": "",
  "SENTRY_TRACES_SAMPLE_RATE": "$([ "$ENVIRONMENT" = "production" ] && echo "1.0" || echo "0.1")",
  "SENTRY_PROFILES_SAMPLE_RATE": "$([ "$ENVIRONMENT" = "production" ] && echo "1.0" || echo "0.1")",
  "AWS_REGION": "$REGION",
  "WORKER": "false",
  "AWS_ALERTS": "$([ "$ENVIRONMENT" = "production" ] && echo "true" || echo "false")",
  "SCHEDULER": "false",
  "GRAFANA_CLOUD_LOKI_ENDPOINT": "",
  "GRAFANA_CLOUD_USER_ID": "",
  "GRAFANA_CLOUD_API_KEY": ""
}
EOF

    aws secretsmanager create-secret \
        --name "$SECRET_NAME" \
        --description "Configuration secrets for Balancer v3 Backend $ENVIRONMENT environment" \
        --secret-string file:///tmp/secret_value.json \
        --region "$REGION"
        
    rm /tmp/secret_value.json
    echo "✅ Secret created successfully"
fi

echo "🎉 Secret initialization completed for $ENVIRONMENT environment" 
