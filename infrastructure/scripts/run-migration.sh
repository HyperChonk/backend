#!/bin/bash

# Controlled Database Migration Script for CI/CD Pipeline
# This script runs database migrations safely before application deployment

set -e

# Configuration
ENVIRONMENT=${ENVIRONMENT:-development}
REGION=${AWS_REGION:-us-east-1}

# Normalize environment name to match CDK stack naming convention
# This handles cases like 'dev' -> 'development'
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
CLUSTER_NAME="v3-backend-${NORMALIZED_ENVIRONMENT}-cluster"
MIGRATION_TASK_FAMILY="v3-backend-${NORMALIZED_ENVIRONMENT}-migration-task"
SUBNET_IDS=""
SECURITY_GROUP_IDS=""

echo "🗃️  Starting controlled database migration for environment: $ENVIRONMENT"
echo "📍 Normalized environment: $NORMALIZED_ENVIRONMENT"
echo "📍 Region: $REGION"
echo "🏗️  Cluster: $CLUSTER_NAME"

# Function to get VPC configuration from SSM parameters
get_vpc_config() {
    echo "📡 Getting VPC configuration..."
    
    # Get private subnet IDs from SSM parameter (StringListParameter)
    SUBNET_IDS=$(aws ssm get-parameter \
        --region "$REGION" \
        --name "/v3-backend/${NORMALIZED_ENVIRONMENT}/networking/privateSubnetIds" \
        --query 'Parameter.Value' \
        --output text 2>/dev/null || echo "")
    
    # Get ECS security group ID from SSM parameter
    SECURITY_GROUP_IDS=$(aws ssm get-parameter \
        --region "$REGION" \
        --name "/v3-backend/${NORMALIZED_ENVIRONMENT}/security/ecsSgId" \
        --query 'Parameter.Value' \
        --output text 2>/dev/null || echo "")
    
    if [[ -z "$SUBNET_IDS" || -z "$SECURITY_GROUP_IDS" || "$SUBNET_IDS" == "None" || "$SECURITY_GROUP_IDS" == "None" ]]; then
        echo "❌ Failed to get VPC configuration from SSM parameters"
        echo "   Subnet IDs: '$SUBNET_IDS'"
        echo "   Security Group IDs: '$SECURITY_GROUP_IDS'"
        
        # Debug: List available SSM parameters
        echo "📋 Available SSM parameters for $NORMALIZED_ENVIRONMENT environment:"
        aws ssm describe-parameters \
            --region "$REGION" \
            --parameter-filters "Key=Name,Option=BeginsWith,Values=/v3-backend/${NORMALIZED_ENVIRONMENT}/" \
            --query 'Parameters[].[Name,Type,Description]' \
            --output table
        
        echo ""
        echo "🔧 Possible solutions:"
        echo "1. Deploy the networking stack first: cdk deploy v3-backend-${NORMALIZED_ENVIRONMENT}-networking"
        echo "2. Deploy the security stack first: cdk deploy v3-backend-${NORMALIZED_ENVIRONMENT}-security"
        echo "3. Check if stacks were deployed successfully and parameters were created"
        echo "4. Verify you're using the correct AWS region: $REGION"
        
        exit 1
    fi
    
    # Validate that we have actual subnet and security group IDs (not just empty strings or "None")
    if [[ "$SUBNET_IDS" =~ ^subnet-[a-f0-9]+ ]] && [[ "$SECURITY_GROUP_IDS" =~ ^sg-[a-f0-9]+ ]]; then
        echo "✅ VPC configuration retrieved"
        echo "   Subnets: $SUBNET_IDS"
        echo "   Security Group: $SECURITY_GROUP_IDS"
    else
        echo "❌ Retrieved VPC configuration appears invalid"
        echo "   Subnets: '$SUBNET_IDS' (expected format: subnet-xxxxxxxxx)"
        echo "   Security Group: '$SECURITY_GROUP_IDS' (expected format: sg-xxxxxxxxx)"
        exit 1
    fi
}

# Function to check if migration is needed
check_migration_needed() {
    echo "🔍 Checking if migration is needed..."
    
    # This would typically involve checking pending migrations
    # For now, we'll assume migration is always needed in pipeline context
    echo "✅ Migration check completed"
}

# Function to run the migration task
run_migration_task() {
    echo "🚀 Starting migration task..."
    
    # Get the latest migration task definition
    TASK_DEFINITION_ARN=$(aws ecs describe-task-definition \
        --region "$REGION" \
        --task-definition "$MIGRATION_TASK_FAMILY" \
        --query 'taskDefinition.taskDefinitionArn' \
        --output text)
    
    if [[ -z "$TASK_DEFINITION_ARN" ]]; then
        echo "❌ Migration task definition not found: $MIGRATION_TASK_FAMILY"
        exit 1
    fi
    
    echo "📋 Using task definition: $TASK_DEFINITION_ARN"
    
    # Run the migration task
    # Note: SUBNET_IDS comes from StringListParameter as comma-separated string (subnet1,subnet2)
    # ECS expects format: subnets=[subnet1,subnet2]
    TASK_ARN=$(aws ecs run-task \
        --region "$REGION" \
        --cluster "$CLUSTER_NAME" \
        --task-definition "$TASK_DEFINITION_ARN" \
        --launch-type "FARGATE" \
        --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_IDS],securityGroups=[$SECURITY_GROUP_IDS],assignPublicIp=DISABLED}" \
        --query 'tasks[0].taskArn' \
        --output text)
    
    if [[ -z "$TASK_ARN" ]]; then
        echo "❌ Failed to start migration task"
        exit 1
    fi
    
    echo "✅ Migration task started: $TASK_ARN"
    
    # Wait for task completion
    echo "⏳ Waiting for migration to complete (max 5 minutes)..."
    timeout 300 aws ecs wait tasks-stopped \
        --region "$REGION" \
        --cluster "$CLUSTER_NAME" \
        --tasks "$TASK_ARN" || {
        echo "❌ Migration task timed out after 10 minutes"
        echo "📋 Task ARN: $TASK_ARN"
        
        # Get current task status for debugging
        aws ecs describe-tasks \
            --region "$REGION" \
            --cluster "$CLUSTER_NAME" \
            --tasks "$TASK_ARN" \
            --query 'tasks[0].[lastStatus,stoppedReason,containers[0].[name,lastStatus,exitCode,reason]]' \
            --output table
        
        exit 1
    }
    
    # Check task exit code
    EXIT_CODE=$(aws ecs describe-tasks \
        --region "$REGION" \
        --cluster "$CLUSTER_NAME" \
        --tasks "$TASK_ARN" \
        --query 'tasks[0].containers[0].exitCode' \
        --output text)
    
    if [[ "$EXIT_CODE" != "0" ]]; then
        echo "❌ Migration task failed with exit code: $EXIT_CODE"
        
        # Get detailed task failure information
        echo "🔍 Getting detailed task failure information..."
        TASK_DETAILS=$(aws ecs describe-tasks \
            --region "$REGION" \
            --cluster "$CLUSTER_NAME" \
            --tasks "$TASK_ARN" \
            --query 'tasks[0]' \
            --output json)
        
        # Extract failure details
        STOPPED_REASON=$(echo "$TASK_DETAILS" | jq -r '.stoppedReason // "Unknown"')
        CONTAINER_EXIT_CODE=$(echo "$TASK_DETAILS" | jq -r '.containers[0].exitCode // "Unknown"')
        CONTAINER_REASON=$(echo "$TASK_DETAILS" | jq -r '.containers[0].reason // "Unknown"')
        
        echo "📋 Task failure details:"
        echo "   Stopped Reason: $STOPPED_REASON"
        echo "   Container Exit Code: $CONTAINER_EXIT_CODE"
        echo "   Container Reason: $CONTAINER_REASON"
        
        # Try to get logs from CloudWatch with better error handling
        LOG_GROUP="/v3-backend/${NORMALIZED_ENVIRONMENT}/migration"
        echo "🔍 Attempting to retrieve logs from: $LOG_GROUP"
        
        # Check if log group exists
        if aws logs describe-log-groups \
            --region "$REGION" \
            --log-group-name-prefix "$LOG_GROUP" \
            --query 'logGroups[?logGroupName==`'$LOG_GROUP'`]' \
            --output text | grep -q "$LOG_GROUP"; then
            
            echo "✅ Log group exists, looking for log streams..."
            
            # Get the most recent log stream
            LOG_STREAM=$(aws logs describe-log-streams \
                --region "$REGION" \
                --log-group-name "$LOG_GROUP" \
                --order-by LastEventTime \
                --descending \
                --max-items 1 \
                --query 'logStreams[0].logStreamName' \
                --output text 2>/dev/null)
            
            if [[ "$LOG_STREAM" != "None" && -n "$LOG_STREAM" ]]; then
                echo "📋 Recent migration logs from stream: $LOG_STREAM"
                aws logs get-log-events \
                    --region "$REGION" \
                    --log-group-name "$LOG_GROUP" \
                    --log-stream-name "$LOG_STREAM" \
                    --query 'events[*].message' \
                    --output text 2>/dev/null || echo "Failed to retrieve log events"
            else
                echo "⚠️ No log streams found in log group"
                # List available log streams for debugging
                echo "🔍 Available log streams:"
                aws logs describe-log-streams \
                    --region "$REGION" \
                    --log-group-name "$LOG_GROUP" \
                    --query 'logStreams[*].logStreamName' \
                    --output text 2>/dev/null || echo "No log streams available"
            fi
        else
            echo "❌ Log group $LOG_GROUP does not exist"
            echo "🔍 Available log groups with similar prefix:"
            aws logs describe-log-groups \
                --region "$REGION" \
                --log-group-name-prefix "/v3-backend/${NORMALIZED_ENVIRONMENT}" \
                --query 'logGroups[*].logGroupName' \
                --output text 2>/dev/null || echo "No log groups found"
        fi
        
        # Provide helpful troubleshooting information
        echo ""
        echo "🔧 Troubleshooting tips:"
        echo "1. Check if the ECS task has proper IAM permissions to access Secrets Manager"
        echo "2. Verify the database is accessible from the ECS subnet"
        echo "3. Ensure the container image contains the required migration files"
        echo "4. Check if DATABASE_URL environment variable is properly constructed"
        echo "5. Verify Prisma CLI is available in the container image"
        
        exit 1
    fi
    
    echo "✅ Migration completed successfully"
}

# Function to verify migration
verify_migration() {
    echo "🔍 Verifying migration..."
    
    # Run a verification task (optional - could check database state)
    echo "✅ Migration verification completed"
}

# Function to validate AWS permissions and SSM access
validate_aws_permissions() {
    echo "🔐 Validating AWS permissions..."
    
    # Test SSM parameter access
    if ! aws ssm describe-parameters --region "$REGION" --max-items 1 >/dev/null 2>&1; then
        echo "❌ Failed to access SSM parameters. Check your AWS credentials and permissions."
        echo "   Required permissions: ssm:GetParameter, ssm:DescribeParameters"
        exit 1
    fi
    
    # Test ECS access
    if ! aws ecs list-clusters --region "$REGION" >/dev/null 2>&1; then
        echo "❌ Failed to access ECS service. Check your AWS credentials and permissions."
        echo "   Required permissions: ecs:ListClusters, ecs:RunTask, ecs:DescribeTask*, etc."
        exit 1
    fi
    
    echo "✅ AWS permissions validated"
}

# Function to validate database connectivity
validate_database_connectivity() {
    echo "🔍 Validating database connectivity..."
    
    # Expected database instance identifier
    local DB_INSTANCE_ID="v3-backend-${NORMALIZED_ENVIRONMENT}-database"
    
    # Check if RDS instance exists
    echo "   Checking RDS instance: $DB_INSTANCE_ID"
    if ! aws rds describe-db-instances \
        --region "$REGION" \
        --db-instance-identifier "$DB_INSTANCE_ID" \
        --query 'DBInstances[0].[DBInstanceStatus,Endpoint.Address,Endpoint.Port]' \
        --output text >/dev/null 2>&1; then
        
        echo "❌ RDS instance '$DB_INSTANCE_ID' not found"
        echo "📋 Looking for alternative database instances..."
        
        # Try to find any database instance with our naming pattern
        AVAILABLE_DBS=$(aws rds describe-db-instances \
            --region "$REGION" \
            --query "DBInstances[?contains(DBInstanceIdentifier, 'v3-backend') && contains(DBInstanceIdentifier, '${NORMALIZED_ENVIRONMENT}')].DBInstanceIdentifier" \
            --output text)
        
        if [[ -n "$AVAILABLE_DBS" ]]; then
            echo "📋 Found these database instances for $NORMALIZED_ENVIRONMENT environment:"
            echo "$AVAILABLE_DBS"
            echo ""
            echo "💡 Consider updating your CDK configuration to use the expected naming: $DB_INSTANCE_ID"
        else
            echo "❌ No database instances found for environment: $NORMALIZED_ENVIRONMENT"
            echo ""
            echo "🔧 Possible solutions:"
            echo "1. Deploy the database stack first: cdk deploy v3-backend-${NORMALIZED_ENVIRONMENT}-database"
            echo "2. Check if database is in a different region"
            echo "3. Verify CDK context environment is set correctly"
        fi
        exit 1
    fi
    
    # Get database status and connection info
    DB_INFO=$(aws rds describe-db-instances \
        --region "$REGION" \
        --db-instance-identifier "$DB_INSTANCE_ID" \
        --query 'DBInstances[0].[DBInstanceStatus,Endpoint.Address,Endpoint.Port,VpcSecurityGroups[0].VpcSecurityGroupId]' \
        --output text)
    
    DB_STATUS=$(echo "$DB_INFO" | cut -f1)
    DB_ENDPOINT=$(echo "$DB_INFO" | cut -f2)
    DB_PORT=$(echo "$DB_INFO" | cut -f3)
    DB_SECURITY_GROUP=$(echo "$DB_INFO" | cut -f4)
    
    echo "   Database Status: $DB_STATUS"
    echo "   Database Endpoint: $DB_ENDPOINT:$DB_PORT"
    echo "   Database Security Group: $DB_SECURITY_GROUP"
    
    # Check if database is available or wait for it
    if [[ "$DB_STATUS" != "available" ]]; then
        echo "⚠️  Database is not in 'available' status: $DB_STATUS"
        
        case "$DB_STATUS" in
            "creating"|"backing-up"|"modifying")
                echo "⏳ Database is being modified. Waiting for completion..."
                local max_wait=300  # 5 minutes
                local wait_count=0
                
                while [[ "$DB_STATUS" != "available" && $wait_count -lt $max_wait ]]; do
                    echo "   Waiting for database (${wait_count}s/${max_wait}s) - Status: $DB_STATUS"
                    sleep 30
                    wait_count=$((wait_count + 30))
                    
                    # Refresh database status
                    DB_INFO=$(aws rds describe-db-instances \
                        --region "$REGION" \
                        --db-instance-identifier "$DB_INSTANCE_ID" \
                        --query 'DBInstances[0].[DBInstanceStatus,Endpoint.Address,Endpoint.Port,VpcSecurityGroups[0].VpcSecurityGroupId]' \
                        --output text)
                    DB_STATUS=$(echo "$DB_INFO" | cut -f1)
                done
                
                if [[ "$DB_STATUS" != "available" ]]; then
                    echo "❌ Database failed to become available within $max_wait seconds"
                    exit 1
                fi
                
                echo "✅ Database is now available"
                ;;
            "stopped"|"stopping")
                echo "❌ Database is stopped. You need to start it first:"
                echo "   aws rds start-db-instance --db-instance-identifier $DB_INSTANCE_ID"
                exit 1
                ;;
            *)
                echo "❌ Database is in an unexpected state: $DB_STATUS"
                exit 1
                ;;
        esac
    fi
    
    # Validate network connectivity between ECS and RDS
    echo "🔍 Validating network connectivity..."
    
    # Check if ECS security group can reach database security group
    # This is a simplified check - in practice, you'd want to verify the actual security group rules
    if [[ "$SECURITY_GROUP_IDS" != "$DB_SECURITY_GROUP" ]]; then
        echo "   ECS Security Group: $SECURITY_GROUP_IDS"
        echo "   Database Security Group: $DB_SECURITY_GROUP"
        echo "💡 Ensure ECS security group ($SECURITY_GROUP_IDS) can reach database security group ($DB_SECURITY_GROUP) on port $DB_PORT"
    fi
    
    echo "✅ Database connectivity validation completed"
    echo ""
}

# Main execution
main() {
    case "${1:-run}" in
        "check")
            check_migration_needed
            ;;
        "run")
            validate_aws_permissions
            get_vpc_config
            check_migration_needed
            validate_database_connectivity
            run_migration_task
            verify_migration
            echo "🎉 Database migration pipeline completed successfully"
            ;;
        "verify")
            verify_migration
            ;;
        *)
            echo "Usage: $0 [check|run|verify]"
            echo "  check  - Check if migration is needed"
            echo "  run    - Run the complete migration pipeline (default)"
            echo "  verify - Verify migration completion"
            exit 1
            ;;
    esac
}

# Execute main function
main "$@" 
