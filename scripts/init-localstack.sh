#!/bin/bash

# Initialize LocalStack SQS queues for local development
# This script creates the necessary SQS queues for the application

set -e

# LocalStack configuration
LOCALSTACK_ENDPOINT="http://localhost:4566"
AWS_REGION="us-east-1"

# Queue names
BACKGROUND_JOB_QUEUE="v3-backend-local-background-job-queue"
DATA_REFRESH_QUEUE="v3-backend-local-data-refresh-queue"
NOTIFICATION_QUEUE="v3-backend-local-notification-queue"

echo "🚀 Initializing LocalStack SQS queues..."

# Function to create a queue if it doesn't exist
create_queue() {
    local queue_name=$1
    
    echo "📋 Creating queue: $queue_name"
    
    aws sqs create-queue \
        --queue-name "$queue_name" \
        --endpoint-url "$LOCALSTACK_ENDPOINT" \
        --region "$AWS_REGION" \
        --no-cli-pager \
        > /dev/null 2>&1 || echo "   Queue $queue_name already exists"
    
    echo "✅ Queue ready: $queue_name"
}

# Function to wait for LocalStack to be ready
wait_for_localstack() {
    echo "⏳ Waiting for LocalStack to be ready..."
    
    for i in {1..30}; do
        if curl -s "$LOCALSTACK_ENDPOINT/_localstack/health" > /dev/null 2>&1; then
            echo "✅ LocalStack is ready"
            return 0
        fi
        echo "   Attempt $i/30: LocalStack not ready yet..."
        sleep 2
    done
    
    echo "❌ LocalStack failed to start within timeout"
    exit 1
}

# Check if LocalStack is running
wait_for_localstack

# Create all queues
create_queue "$BACKGROUND_JOB_QUEUE"
create_queue "$DATA_REFRESH_QUEUE"
create_queue "$NOTIFICATION_QUEUE"

echo ""
echo "🎉 LocalStack SQS initialization complete!"
echo ""
echo "📋 Available queues:"
echo "   • Background Jobs: $LOCALSTACK_ENDPOINT/000000000000/$BACKGROUND_JOB_QUEUE"
echo "   • Data Refresh:    $LOCALSTACK_ENDPOINT/000000000000/$DATA_REFRESH_QUEUE"
echo "   • Notifications:   $LOCALSTACK_ENDPOINT/000000000000/$NOTIFICATION_QUEUE"
echo ""
echo "🔧 You can now start your Worker and Scheduler services" 
