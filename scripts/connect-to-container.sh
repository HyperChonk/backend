#!/bin/bash

# Connect to ECS container using AWS ECS Exec
# Usage: ./scripts/connect-to-container.sh [environment] [service_type]
# Example: ./scripts/connect-to-container.sh development api

set -e

# Default values
ENVIRONMENT=${1:-development}
SERVICE_TYPE=${2:-api}  # api or background-processor
REGION=${AWS_REGION:-us-east-1}

# Generate resource names based on your CDK naming convention
CLUSTER_NAME="v3-backend-${ENVIRONMENT}-cluster"
SERVICE_NAME="v3-backend-${ENVIRONMENT}-${SERVICE_TYPE}-service"

if [ "$SERVICE_TYPE" = "api" ]; then
    CONTAINER_NAME="v3-backend-api"
elif [ "$SERVICE_TYPE" = "background-processor" ]; then
    CONTAINER_NAME="v3-backend-background-processor"
else
    echo "❌ Invalid service type. Use 'api' or 'background-processor'"
    exit 1
fi

echo "🔍 Connecting to $SERVICE_TYPE container in $ENVIRONMENT environment..."
echo "📍 Cluster: $CLUSTER_NAME"
echo "📍 Service: $SERVICE_NAME"
echo "📍 Container: $CONTAINER_NAME"
echo "📍 Region: $REGION"

# Get the running task ARN
echo "🔍 Finding running task..."
TASK_ARN=$(aws ecs list-tasks \
    --cluster "$CLUSTER_NAME" \
    --service-name "$SERVICE_NAME" \
    --region "$REGION" \
    --query 'taskArns[0]' \
    --output text)

if [ "$TASK_ARN" = "None" ] || [ -z "$TASK_ARN" ]; then
    echo "❌ No running tasks found for service $SERVICE_NAME"
    echo "💡 Check if the service is running:"
    echo "   aws ecs describe-services --cluster $CLUSTER_NAME --services $SERVICE_NAME --region $REGION"
    exit 1
fi

echo "✅ Found running task: $TASK_ARN"

# Connect to the container
echo "🚀 Connecting to container..."
echo "💡 You'll be dropped into a shell inside the running container"
echo "---"

aws ecs execute-command \
    --region "$REGION" \
    --cluster "$CLUSTER_NAME" \
    --task "$TASK_ARN" \
    --container "$CONTAINER_NAME" \
    --interactive \
    --command "/bin/sh" 
