#!/bin/bash
set -e

echo "🔑 Initializing secrets from AWS Secrets Manager..."

# Check if required AWS environment variables are set
if [ -z "$AWS_REGION" ]; then
  export AWS_REGION="us-east-1"
  echo "ℹ️  AWS_REGION not set, defaulting to us-east-1"
fi

# Get environment from NODE_ENV or default to development
ENVIRONMENT=${NODE_ENV:-development}
echo "📍 Environment: $ENVIRONMENT"

# Construct secret name based on environment
SECRET_NAME="v3-backend/${ENVIRONMENT}/config"

echo "🔍 Fetching secret: $SECRET_NAME from region: $AWS_REGION"

# Check if we're running in AWS (has metadata service) or local development
if curl -m 5 -s http://169.254.169.254/latest/meta-data/instance-id > /dev/null 2>&1; then
  echo "☁️  Running in AWS environment"
  
  # Fetch secret from AWS Secrets Manager
  SECRET_JSON=$(aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$SECRET_NAME" \
    --query SecretString \
    --output text 2>/dev/null)
  
  if [ $? -ne 0 ] || [ -z "$SECRET_JSON" ]; then
    echo "❌ Failed to fetch secret: $SECRET_NAME"
    echo "🔧 Available secrets:"
    aws secretsmanager list-secrets --region "$AWS_REGION" --query 'SecretList[].Name' --output table 2>/dev/null || echo "Failed to list secrets"
    exit 1
  fi
  
  echo "✅ Secret fetched successfully"
  
  # Parse JSON and convert to .env format in a temporary file
  echo "$SECRET_JSON" | jq -r 'to_entries[] | "\(.key)=\(.value)"' > /tmp/.env
  
  # Validate the .env file was created properly
  if [ ! -s /tmp/.env ]; then
    echo "❌ Failed to parse secret JSON or .env file is empty"
    echo "Secret JSON sample: $(echo "$SECRET_JSON" | head -c 100)..."
    exit 1
  fi
  
  echo "🔧 Environment variables parsed:"
  # Show variable names (not values) for debugging
  cat /tmp/.env | cut -d'=' -f1 | while read var; do
    echo "  - $var"
  done
  
  # Source the environment variables
  set -a
  source /tmp/.env
  set +a
  
  # Clean up temporary file
  rm -f /tmp/.env
  
  echo "✅ Secrets initialized from AWS Secrets Manager"
  
else
  echo "💻 Running in local development environment"
  
  # Check for local .env file
  if [ -f ".env" ]; then
    echo "📋 Using local .env file"
    set -a
    source .env
    set +a
    echo "✅ Local environment variables loaded"
  else
    echo "⚠️  No .env file found and not in AWS environment"
    echo "🔧 For local development, create a .env file with your configuration"
    echo "🔧 For AWS deployment, ensure the secret '$SECRET_NAME' exists in Secrets Manager"
  fi
fi

# Validate essential environment variables
echo "🔍 Validating essential environment variables..."

REQUIRED_VARS=("DATABASE_URL")
MISSING_VARS=()

for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var}" ]; then
    MISSING_VARS+=("$var")
  fi
done

if [ ${#MISSING_VARS[@]} -ne 0 ]; then
  echo "❌ Missing required environment variables:"
  printf '  - %s\n' "${MISSING_VARS[@]}"
  exit 1
fi

echo "✅ All required environment variables are set"

# Set default values for optional variables
export PORT=${PORT:-3000}
export NODE_ENV=${NODE_ENV:-$ENVIRONMENT}

echo "🚀 Environment initialization complete!"
echo "   - Environment: $NODE_ENV"
echo "   - Port: $PORT"
echo "   - Database: ${DATABASE_URL:0:20}..." 
