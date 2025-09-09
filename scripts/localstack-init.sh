#!/bin/bash

# Simplified LocalStack initialization script
# This script creates only essential AWS resources for local development

set -e

echo "🚀 Initializing LocalStack with essential Balancer v3 Backend resources..."

# Basic wait for LocalStack to be ready
echo "⏳ Waiting for LocalStack to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:4566/_localstack/health | grep -q '"sqs": "available"'; then
        echo "✅ LocalStack is ready!"
        break
    fi
    echo "   Attempt $i/30: Waiting for LocalStack..."
    sleep 2
done

# Set AWS configuration for LocalStack
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export AWS_ENDPOINT_URL=http://localhost:4566

# Environment for resource naming
ENV="local"

echo "📋 Creating essential SQS Queues..."

# Simple function to create SQS queue
create_sqs_queue() {
    local queue_name=$1
    
    if aws sqs create-queue --queue-name "$queue_name" --endpoint-url=$AWS_ENDPOINT_URL >/dev/null 2>&1; then
        echo "✅ Created queue: $queue_name"
    elif aws sqs get-queue-url --queue-name "$queue_name" --endpoint-url=$AWS_ENDPOINT_URL >/dev/null 2>&1; then
        echo "ℹ️  Queue already exists: $queue_name"
    else
        echo "❌ Failed to create queue: $queue_name"
        exit 1
    fi
}

# Function to create SQS queue with DLQ configuration
create_sqs_queue_with_dlq() {
    local queue_name=$1
    local dlq_arn=$2
    local max_receive_count=${3:-3}  # Default to 3 retries
    
    # First, create the queue without attributes (more reliable in LocalStack)
    if ! aws sqs get-queue-url --queue-name "$queue_name" --endpoint-url=$AWS_ENDPOINT_URL >/dev/null 2>&1; then
        aws sqs create-queue --queue-name "$queue_name" --endpoint-url=$AWS_ENDPOINT_URL >/dev/null
        echo "✅ Created queue: $queue_name"
    else
        echo "ℹ️  Queue already exists: $queue_name"
    fi
    
    # Get the queue URL, exit if not found
    local queue_url
    queue_url=$(aws sqs get-queue-url --queue-name "$queue_name" --endpoint-url=$AWS_ENDPOINT_URL --output text --query 'QueueUrl' 2>/dev/null)
    if [ -z "$queue_url" ]; then
        echo "❌ Could not get queue URL for $queue_name"
        exit 1
    fi
    
    # The value for RedrivePolicy must be a string containing a JSON object.
    # The maxReceiveCount should be a string within that JSON object for maximum compatibility.
    local redrive_policy="{\"deadLetterTargetArn\":\"$dlq_arn\",\"maxReceiveCount\":\"$max_receive_count\"}"
    
    if aws sqs set-queue-attributes \
        --queue-url "$queue_url" \
        --attributes "RedrivePolicy=$redrive_policy" \
        --endpoint-url=$AWS_ENDPOINT_URL >/dev/null 2>&1; then
        echo "✅ Configured DLQ policy for $queue_name (max retries: $max_receive_count)"
    else
        echo "❌ Failed to set DLQ policy for $queue_name"
        exit 1
    fi
}

# Function to get queue ARN
get_queue_arn() {
    local queue_name=$1
    local queue_url=$(aws sqs get-queue-url --queue-name "$queue_name" --endpoint-url=$AWS_ENDPOINT_URL --output text --query 'QueueUrl')
    aws sqs get-queue-attributes --queue-url "$queue_url" --attribute-names QueueArn --endpoint-url=$AWS_ENDPOINT_URL --output text --query 'Attributes.QueueArn'
}

# Create DLQ first (without RedrivePolicy - it's the final destination)
echo "🔄 Creating Dead Letter Queue..."
create_sqs_queue "v3-backend-${ENV}-dlq"

# Get DLQ ARN for RedrivePolicy configuration
echo "🔍 Getting DLQ ARN..."
DLQ_ARN=$(get_queue_arn "v3-backend-${ENV}-dlq")
echo "✅ DLQ ARN: $DLQ_ARN"

# Create main queues with DLQ configuration
echo "🔗 Creating main queues with DLQ configuration..."
create_sqs_queue_with_dlq "v3-backend-${ENV}-background-job-queue" "$DLQ_ARN" 3
create_sqs_queue_with_dlq "v3-backend-${ENV}-data-refresh-queue" "$DLQ_ARN" 5  # More retries for data refresh
create_sqs_queue_with_dlq "v3-backend-${ENV}-notification-queue" "$DLQ_ARN" 2   # Fewer retries for notifications

echo "📦 Creating essential S3 Buckets..."

# Simple function to create S3 bucket
create_s3_bucket() {
    local bucket_name=$1
    
    if aws s3 mb "s3://$bucket_name" --endpoint-url=$AWS_ENDPOINT_URL >/dev/null 2>&1; then
        echo "✅ Created bucket: $bucket_name"
    elif aws s3 ls "s3://$bucket_name" --endpoint-url=$AWS_ENDPOINT_URL >/dev/null 2>&1; then
        echo "ℹ️  Bucket already exists: $bucket_name"
    else
        echo "❌ Failed to create bucket: $bucket_name"
        exit 1
    fi
}

# Create only essential S3 buckets
create_s3_bucket "v3-backend-${ENV}-artifacts"
create_s3_bucket "v3-backend-${ENV}-logs"

echo "✅ LocalStack initialization complete!"
echo ""
echo "🔗 LocalStack Services Available at: http://localhost:4566"
echo "📋 Created Resources:"
echo "   - 3 Main SQS Queues (with DLQ policies)"
echo "   - 1 Dead Letter Queue"
echo "   - 2 S3 Buckets"
echo ""
echo "🎯 DLQ Configuration:"
echo "   - Background Job Queue: 3 retries before DLQ"
echo "   - Data Refresh Queue: 5 retries before DLQ"  
echo "   - Notification Queue: 2 retries before DLQ"
echo ""
echo "🎉 LocalStack is ready for Balancer v3 Backend with functional DLQ!" 
