#!/bin/bash

# RDS Snapshot Export Script for Balancer v3 Backend
# This script creates a manual snapshot, exports it to S3, and downloads the data

set -e

# Configuration
ENVIRONMENT=${ENVIRONMENT:-development}
REGION=${AWS_REGION:-us-east-1}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Normalize environment name
normalize_environment() {
    case "$1" in
        "dev"|"development")
            echo "development"
            ;;
        "staging"|"stage")
            echo "staging"
            ;;
        "prod"|"production")
            echo "production"
            ;;
        *)
            echo >&2 "⚠️  Unknown environment '$1', defaulting to development"
            echo "development"
            ;;
    esac
}

NORMALIZED_ENVIRONMENT=$(normalize_environment "$ENVIRONMENT")
DB_INSTANCE_ID="v3-backend-${NORMALIZED_ENVIRONMENT}-database"
SNAPSHOT_ID="manual-snapshot-${NORMALIZED_ENVIRONMENT}-${TIMESTAMP}"
EXPORT_TASK_ID="export-${NORMALIZED_ENVIRONMENT}-${TIMESTAMP}"
S3_BUCKET="v3-backend-${NORMALIZED_ENVIRONMENT}-logs"  # Using existing logs bucket
S3_PREFIX="database-exports/${EXPORT_TASK_ID}"
ACCOUNT_ID=""
EXPORT_ROLE_ARN=""

echo "🗃️  Starting RDS snapshot export for environment: $ENVIRONMENT"
echo "📍 Normalized environment: $NORMALIZED_ENVIRONMENT"
echo "📍 Region: $REGION"
echo "🗄️  Database instance: $DB_INSTANCE_ID"
echo "📸 Snapshot ID: $SNAPSHOT_ID"
echo "📤 Export task ID: $EXPORT_TASK_ID"

# Function to get AWS account ID
get_account_id() {
    echo "🔍 Getting AWS account ID..."
    ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text)
    echo "✅ Account ID: $ACCOUNT_ID"
}

# Function to check if database exists
check_database() {
    echo "🔍 Checking if database exists..."
    
    if ! aws rds describe-db-instances \
        --region "$REGION" \
        --db-instance-identifier "$DB_INSTANCE_ID" \
        --query 'DBInstances[0].DBInstanceStatus' \
        --output text >/dev/null 2>&1; then
        
        echo "❌ Database instance '$DB_INSTANCE_ID' not found"
        echo "📋 Available database instances:"
        aws rds describe-db-instances \
            --region "$REGION" \
            --query 'DBInstances[].DBInstanceIdentifier' \
            --output table
        exit 1
    fi
    
    DB_STATUS=$(aws rds describe-db-instances \
        --region "$REGION" \
        --db-instance-identifier "$DB_INSTANCE_ID" \
        --query 'DBInstances[0].DBInstanceStatus' \
        --output text)
    
    echo "✅ Database found with status: $DB_STATUS"
    
    if [[ "$DB_STATUS" != "available" ]]; then
        echo "⚠️  Database is not in 'available' status. Current status: $DB_STATUS"
        echo "💡 The snapshot can still be created, but it's recommended to wait for 'available' status"
    fi
}

# Function to check S3 bucket permissions
check_s3_bucket() {
    echo "🪣 Checking S3 bucket: $S3_BUCKET"
    
    if aws s3 ls "s3://$S3_BUCKET" >/dev/null 2>&1; then
        echo "✅ S3 bucket is accessible"
    else
        echo "❌ S3 bucket '$S3_BUCKET' is not accessible"
        echo "💡 Available buckets for this environment:"
        aws s3 ls | grep "v3-backend-${NORMALIZED_ENVIRONMENT}" || echo "No buckets found"
        exit 1
    fi
    
    # Check if we can write to the bucket
    TEST_FILE="database-exports/test-${TIMESTAMP}.txt"
    echo "Testing S3 write permissions" | aws s3 cp - "s3://${S3_BUCKET}/${TEST_FILE}"
    aws s3 rm "s3://${S3_BUCKET}/${TEST_FILE}"
    echo "✅ S3 bucket write permissions confirmed"
}

# Function to create manual snapshot
create_snapshot() {
    echo "📸 Creating manual snapshot..."
    
    # Check if snapshot already exists
    if aws rds describe-db-snapshots \
        --region "$REGION" \
        --db-snapshot-identifier "$SNAPSHOT_ID" \
        --query 'DBSnapshots[0].Status' \
        --output text >/dev/null 2>&1; then
        
        EXISTING_STATUS=$(aws rds describe-db-snapshots \
            --region "$REGION" \
            --db-snapshot-identifier "$SNAPSHOT_ID" \
            --query 'DBSnapshots[0].Status' \
            --output text)
        
        echo "⚠️  Snapshot '$SNAPSHOT_ID' already exists with status: $EXISTING_STATUS"
        
        if [[ "$EXISTING_STATUS" == "available" ]]; then
            echo "✅ Using existing completed snapshot"
            return 0
        elif [[ "$EXISTING_STATUS" == "creating" ]]; then
            echo "⏳ Snapshot is already being created, waiting for completion..."
        else
            echo "❌ Snapshot is in unexpected status: $EXISTING_STATUS"
            exit 1
        fi
    else
        # Create new snapshot
        echo "🚀 Creating new snapshot..."
        aws rds create-db-snapshot \
            --region "$REGION" \
            --db-instance-identifier "$DB_INSTANCE_ID" \
            --db-snapshot-identifier "$SNAPSHOT_ID"
        
        echo "✅ Snapshot creation initiated"
    fi
    
    # Wait for snapshot completion
    echo "⏳ Waiting for snapshot to complete (this may take 10-30 minutes)..."
    
    while true; do
        SNAPSHOT_STATUS=$(aws rds describe-db-snapshots \
            --region "$REGION" \
            --db-snapshot-identifier "$SNAPSHOT_ID" \
            --query 'DBSnapshots[0].Status' \
            --output text)
        
        PROGRESS=$(aws rds describe-db-snapshots \
            --region "$REGION" \
            --db-snapshot-identifier "$SNAPSHOT_ID" \
            --query 'DBSnapshots[0].PercentProgress' \
            --output text)
        
        echo "   Snapshot status: $SNAPSHOT_STATUS (${PROGRESS}% complete)"
        
        case "$SNAPSHOT_STATUS" in
            "available")
                echo "✅ Snapshot completed successfully"
                break
                ;;
            "creating")
                sleep 60  # Wait 1 minute before checking again
                ;;
            "failed"|"error")
                echo "❌ Snapshot creation failed"
                exit 1
                ;;
            *)
                echo "⚠️  Unexpected snapshot status: $SNAPSHOT_STATUS"
                sleep 60
                ;;
        esac
    done
}

# Function to start export task
start_export_task() {
    echo "📤 Starting export task..."
    
    SNAPSHOT_ARN="arn:aws:rds:${REGION}:${ACCOUNT_ID}:snapshot:${SNAPSHOT_ID}"
    
    # Check if export task already exists
    if aws rds describe-export-tasks \
        --region "$REGION" \
        --export-task-identifier "$EXPORT_TASK_ID" \
        --query 'ExportTasks[0].Status' \
        --output text >/dev/null 2>&1; then
        
        EXISTING_STATUS=$(aws rds describe-export-tasks \
            --region "$REGION" \
            --export-task-identifier "$EXPORT_TASK_ID" \
            --query 'ExportTasks[0].Status' \
            --output text)
        
        echo "⚠️  Export task '$EXPORT_TASK_ID' already exists with status: $EXISTING_STATUS"
        
        case "$EXISTING_STATUS" in
            "COMPLETE")
                echo "✅ Using existing completed export"
                return 0
                ;;
            "IN_PROGRESS"|"STARTING")
                echo "⏳ Export is already in progress, waiting for completion..."
                ;;
            *)
                echo "❌ Export task is in unexpected status: $EXISTING_STATUS"
                exit 1
                ;;
        esac
    else
        # Start new export task
        echo "🚀 Starting new export task..."
                 aws rds start-export-task \
             --region "$REGION" \
             --export-task-identifier "$EXPORT_TASK_ID" \
             --source-arn "$SNAPSHOT_ARN" \
             --s3-bucket-name "$S3_BUCKET" \
             --s3-prefix "$S3_PREFIX" \
             --iam-role-arn "$EXPORT_ROLE_ARN" \
             --kms-key-id "alias/aws/s3"
        
        echo "✅ Export task initiated"
    fi
    
    # Wait for export completion
    echo "⏳ Waiting for export to complete (this may take 30-60 minutes for large databases)..."
    
    while true; do
        EXPORT_STATUS=$(aws rds describe-export-tasks \
            --region "$REGION" \
            --export-task-identifier "$EXPORT_TASK_ID" \
            --query 'ExportTasks[0].Status' \
            --output text)
        
        PROGRESS=$(aws rds describe-export-tasks \
            --region "$REGION" \
            --export-task-identifier "$EXPORT_TASK_ID" \
            --query 'ExportTasks[0].PercentProgress' \
            --output text 2>/dev/null || echo "0")
        
        echo "   Export status: $EXPORT_STATUS (${PROGRESS}% complete)"
        
        case "$EXPORT_STATUS" in
            "COMPLETE")
                echo "✅ Export completed successfully"
                break
                ;;
            "IN_PROGRESS"|"STARTING")
                sleep 120  # Wait 2 minutes before checking again
                ;;
            "FAILED"|"CANCELED")
                echo "❌ Export task failed or was canceled"
                
                # Get failure reason
                FAILURE_REASON=$(aws rds describe-export-tasks \
                    --region "$REGION" \
                    --export-task-identifier "$EXPORT_TASK_ID" \
                    --query 'ExportTasks[0].FailureCause' \
                    --output text)
                
                echo "❌ Failure reason: $FAILURE_REASON"
                exit 1
                ;;
            *)
                echo "⚠️  Unexpected export status: $EXPORT_STATUS"
                sleep 120
                ;;
        esac
    done
}

# Function to download exported data
download_export() {
    echo "📥 Downloading exported data..."
    
    LOCAL_EXPORT_PATH="./database-exports/${EXPORT_TASK_ID}"
    mkdir -p "$LOCAL_EXPORT_PATH"
    
    echo "🔍 Listing exported files in S3..."
    aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" --recursive
    
    echo "📥 Downloading all exported files..."
    aws s3 sync "s3://${S3_BUCKET}/${S3_PREFIX}/" "$LOCAL_EXPORT_PATH"
    
    if [[ -d "$LOCAL_EXPORT_PATH" && "$(ls -A "$LOCAL_EXPORT_PATH")" ]]; then
        echo "✅ Export downloaded to: $LOCAL_EXPORT_PATH"
        echo "📊 Directory size: $(du -sh "$LOCAL_EXPORT_PATH" | cut -f1)"
        echo "📋 Downloaded files:"
        find "$LOCAL_EXPORT_PATH" -type f -exec basename {} \; | sort
    else
        echo "❌ Failed to download export files"
        exit 1
    fi
}

# Function to clean up resources
cleanup() {
    echo "🧹 Cleanup options:"
    
    # Cleanup snapshot
    read -p "🗑️  Do you want to delete the manual snapshot? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        aws rds delete-db-snapshot \
            --region "$REGION" \
            --db-snapshot-identifier "$SNAPSHOT_ID"
        echo "✅ Snapshot deleted"
    else
        echo "📦 Snapshot kept: $SNAPSHOT_ID"
    fi
    
    # Cleanup S3 export
    read -p "🗑️  Do you want to remove the export from S3? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}/" --recursive
        echo "✅ S3 export files removed"
    else
        echo "📦 S3 export kept at: s3://${S3_BUCKET}/${S3_PREFIX}/"
    fi
}

# Function to get IAM role for export from CloudFormation
get_export_role_arn() {
    echo "🔒 Getting IAM role for RDS export from CloudFormation..."
    
    EXPORT_ROLE_ARN=$(aws cloudformation describe-stacks \
        --region "$REGION" \
        --stack-name "v3-backend-${NORMALIZED_ENVIRONMENT}-database" \
        --query 'Stacks[0].Outputs[?OutputKey==`RDSExportRoleArn`].OutputValue' \
        --output text)
    
    if [[ -z "$EXPORT_ROLE_ARN" || "$EXPORT_ROLE_ARN" == "None" ]]; then
        echo "❌ RDS export role not found in CloudFormation outputs"
        echo "💡 Make sure the database stack is deployed with the export role:"
        echo "   cd infrastructure && cdk deploy v3-backend-${NORMALIZED_ENVIRONMENT}-database"
        exit 1
    fi
    
    echo "✅ Found export role: $EXPORT_ROLE_ARN"
}

# Main execution
main() {
    case "${1:-export}" in
        "export"|"create")
                         get_account_id
             check_database
             check_s3_bucket
             get_export_role_arn
             create_snapshot
            start_export_task
            download_export
            cleanup
            echo "🎉 Database export process completed!"
            ;;
        "download")
            if [[ -z "$2" ]]; then
                echo "❌ Please provide export task ID for download"
                echo "Usage: $0 download <export-task-id>"
                exit 1
            fi
            EXPORT_TASK_ID="$2"
            S3_PREFIX="database-exports/${EXPORT_TASK_ID}"
            download_export
            ;;
        "list-snapshots")
            echo "📋 Available manual snapshots:"
            aws rds describe-db-snapshots \
                --region "$REGION" \
                --snapshot-type manual \
                --query 'DBSnapshots[?contains(DBSnapshotIdentifier, `manual-snapshot-${NORMALIZED_ENVIRONMENT}`)].{ID:DBSnapshotIdentifier,Status:Status,Created:SnapshotCreateTime}' \
                --output table
            ;;
        "list-exports")
            echo "📋 Available export tasks:"
            aws rds describe-export-tasks \
                --region "$REGION" \
                --query 'ExportTasks[?contains(ExportTaskIdentifier, `export-${NORMALIZED_ENVIRONMENT}`)].{ID:ExportTaskIdentifier,Status:Status,Progress:PercentProgress}' \
                --output table
            ;;
        *)
            echo "Usage: $0 [export|download|list-snapshots|list-exports]"
            echo "  export           - Create snapshot, export to S3, and download (default)"
            echo "  download         - Download existing export from S3"
            echo "  list-snapshots   - List available manual snapshots"
            echo "  list-exports     - List available export tasks"
            exit 1
            ;;
    esac
}

# Execute main function
main "$@" 
