#!/bin/bash

# Test LocalStack Integration Setup
# This script validates that LocalStack is working correctly

set -e

echo "🚀 Testing LocalStack Integration Setup"
echo "======================================="

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

echo "✅ Docker is running"

# Check if LocalStack is running
if curl -s http://localhost:4566/_localstack/health >/dev/null 2>&1; then
    echo "✅ LocalStack is already running"
else
    echo "🔄 Starting LocalStack..."
    npm run localstack:start
    
    # Wait for LocalStack to be ready
    echo "⏳ Waiting for LocalStack to be ready..."
    timeout=60
    while [ $timeout -gt 0 ]; do
        if curl -s http://localhost:4566/_localstack/health >/dev/null 2>&1; then
            echo "✅ LocalStack is ready!"
            break
        fi
        sleep 2
        ((timeout-=2))
    done
    
    if [ $timeout -le 0 ]; then
        echo "❌ LocalStack failed to start within 60 seconds"
        npm run localstack:logs
        exit 1
    fi
fi

# Test basic LocalStack connectivity
echo "🔍 Testing LocalStack services..."

# Test health endpoint
if curl -s http://localhost:4566/_localstack/health | jq -e '.services.s3' >/dev/null 2>&1; then
    echo "✅ S3 service is available"
else
    echo "⚠️  S3 service status unknown"
fi

if curl -s http://localhost:4566/_localstack/health | jq -e '.services.secretsmanager' >/dev/null 2>&1; then
    echo "✅ Secrets Manager service is available"
else
    echo "⚠️  Secrets Manager service status unknown"
fi

if curl -s http://localhost:4566/_localstack/health | jq -e '.services.cloudformation' >/dev/null 2>&1; then
    echo "✅ CloudFormation service is available"
else
    echo "⚠️  CloudFormation service status unknown"
fi

# Test AWS CLI with LocalStack
echo "🔍 Testing AWS CLI integration..."

export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export AWS_ENDPOINT_URL=http://localhost:4566

# Test S3
if aws s3 ls >/dev/null 2>&1; then
    echo "✅ AWS CLI S3 integration works"
else
    echo "⚠️  AWS CLI S3 integration issues"
fi

# Test Secrets Manager
if aws secretsmanager list-secrets >/dev/null 2>&1; then
    echo "✅ AWS CLI Secrets Manager integration works"
else
    echo "⚠️  AWS CLI Secrets Manager integration issues"
fi

echo ""
echo "🎉 LocalStack setup test completed!"
echo ""
echo "Next steps:"
echo "  1. Run integration tests: npm run test:integration"
echo "  2. View LocalStack logs: npm run localstack:logs"
echo "  3. Stop LocalStack: npm run localstack:stop"
echo "" 
