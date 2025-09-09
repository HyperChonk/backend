#!/bin/bash

# DLQ Utilities for Local Development and AWS Environments
# This script provides helpful commands for debugging failed messages in the Dead Letter Queue

set -e

# Environment detection and configuration
if [ "$1" = "aws" ] || [ "$1" = "development" ] || [ "$1" = "staging" ] || [ "$1" = "production" ]; then
    # AWS Environment
    ENV="$1"
    if [ "$ENV" = "aws" ]; then
        ENV="development"  # Default to development for 'aws' command
    fi
    
    # Use AWS credentials from environment (no LocalStack config)
    unset AWS_ENDPOINT_URL
    export AWS_DEFAULT_REGION=us-east-1
    
    # Get AWS account ID from current session
    AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "367675988308")
    
    DLQ_NAME="v3-backend-${ENV}-background-job-dlq"
    QUEUE_BASE_URL="https://sqs.us-east-1.amazonaws.com/${AWS_ACCOUNT_ID}"
    
    # Function to get AWS queue URL
    get_queue_url() {
        local queue_name=$1
        echo "${QUEUE_BASE_URL}/${queue_name}"
    }
    
    # Function to get AWS queue attributes
    get_queue_attributes() {
        local queue_url=$1
        
        local output
        output=$(aws sqs get-queue-attributes \
            --queue-url "$queue_url" \
            --attribute-names All \
            --region us-east-1 \
            --output json 2>&1) # Redirect stderr to stdout to capture errors
        
        local exit_code=$?
        
        if [ $exit_code -ne 0 ]; then
            echo -e "${RED}Error fetching queue attributes for $queue_url (exit code: $exit_code):${NC}" >&2
            echo -e "${YELLOW}$output${NC}" >&2
            echo "{}" # Return empty JSON on error
            return 1
        fi
        
        # Check if output is a valid JSON
        if ! echo "$output" | jq -e . >/dev/null 2>&1; then
            echo -e "${RED}Invalid JSON response from get-queue-attributes for $queue_url:${NC}" >&2
            echo -e "${YELLOW}$output${NC}" >&2
            echo "{}" # Return empty JSON on error
            return 1
        fi
        
        echo "$output"
    }
    
    # Function to receive AWS messages
    receive_messages() {
        local queue_url=$1
        local max_messages=$2
        aws sqs receive-message \
            --queue-url "$queue_url" \
            --max-number-of-messages "$max_messages" \
            --region us-east-1 \
            --output json 2>/dev/null || echo "{}"
    }
    
    # Function to delete AWS message
    delete_message() {
        local queue_url=$1
        local receipt_handle=$2
        aws sqs delete-message \
            --queue-url "$queue_url" \
            --receipt-handle "$receipt_handle" \
            --region us-east-1 >/dev/null
    }
    
    # Function to purge AWS queue (native AWS operation)
    purge_queue() {
        local queue_url=$1
        aws sqs purge-queue \
            --queue-url "$queue_url" \
            --region us-east-1 2>/dev/null
    }
    
    shift  # Remove environment argument from $@
else
    # LocalStack configuration (default for local development)
    export AWS_ACCESS_KEY_ID=test
    export AWS_SECRET_ACCESS_KEY=test
    export AWS_DEFAULT_REGION=us-east-1
    export AWS_ENDPOINT_URL=http://localhost:4566
    
    ENV="local"
    DLQ_NAME="v3-backend-${ENV}-dlq"
    
    # Function to get LocalStack queue URL
    get_queue_url() {
        local queue_name=$1
        aws sqs get-queue-url --queue-name "$queue_name" --endpoint-url=$AWS_ENDPOINT_URL --output text --query 'QueueUrl' 2>/dev/null || echo ""
    }
    
    # Function to get LocalStack queue attributes
    get_queue_attributes() {
        local queue_url=$1
        local attributes=$2
        aws sqs get-queue-attributes \
            --queue-url "$queue_url" \
            --attribute-names "$attributes" \
            --endpoint-url=$AWS_ENDPOINT_URL \
            --output json 2>/dev/null || echo "{}"
    }
    
    # Function to receive LocalStack messages
    receive_messages() {
        local queue_url=$1
        local max_messages=$2
        aws sqs receive-message \
            --queue-url "$queue_url" \
            --max-number-of-messages "$max_messages" \
            --endpoint-url=$AWS_ENDPOINT_URL \
            --output json 2>/dev/null || echo "{}"
    }
    
    # Function to delete LocalStack message
    delete_message() {
        local queue_url=$1
        local receipt_handle=$2
        aws sqs delete-message \
            --queue-url "$queue_url" \
            --receipt-handle "$receipt_handle" \
            --endpoint-url=$AWS_ENDPOINT_URL >/dev/null
    }
    
    # Function to purge LocalStack queue
    purge_queue() {
        local queue_url=$1
        aws sqs purge-queue \
            --queue-url "$queue_url" \
            --endpoint-url=$AWS_ENDPOINT_URL 2>/dev/null
    }
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

# Function to check DLQ message count
check_dlq_count() {
    local queue_url=$(get_queue_url "$DLQ_NAME")
    if [ -z "$queue_url" ]; then
        echo -e "${RED}❌ DLQ not found: $DLQ_NAME${NC}"
        return 1
    fi
    
    local attrs=$(get_queue_attributes "$queue_url")
    local message_count=$(echo "$attrs" | jq -r '.Attributes.ApproximateNumberOfMessages // "0"')
    
    echo -e "${BLUE}📊 DLQ Message Count: ${YELLOW}$message_count${NC}"
    return $message_count
}

# Function to peek at DLQ status without receiving messages (non-intrusive)
peek_dlq_status() {
    local queue_url=$(get_queue_url "$DLQ_NAME")
    if [ -z "$queue_url" ]; then
        echo -e "${RED}❌ DLQ not found: $DLQ_NAME${NC}"
        return 1
    fi
    
    echo -e "${BLUE}👀 Checking DLQ status (non-intrusive)...${NC}"
    
    local attrs=$(get_queue_attributes "$queue_url")
    local available_count=$(echo "$attrs" | jq -r '.Attributes.ApproximateNumberOfMessages // "0"')
    local invisible_count=$(echo "$attrs" | jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible // "0"')
    local visibility_timeout=$(echo "$attrs" | jq -r '.Attributes.VisibilityTimeout // "30"')
    local retention_period=$(echo "$attrs" | jq -r '.Attributes.MessageRetentionPeriod // "1209600"')
    local created_timestamp=$(echo "$attrs" | jq -r '.Attributes.CreatedTimestamp // "0"')
    
    echo -e "${BLUE}📊 DLQ Status Report:${NC}"
    echo -e "   Queue: ${YELLOW}$DLQ_NAME${NC}"
    echo -e "   Available Messages: ${YELLOW}$available_count${NC}"
    echo -e "   In-Flight Messages: ${YELLOW}$invisible_count${NC}"
    echo -e "   Total Messages: ${YELLOW}$((available_count + invisible_count))${NC}"
    echo -e "   Visibility Timeout: ${YELLOW}${visibility_timeout}s${NC}"
    echo -e "   Message Retention: ${YELLOW}$((retention_period / 86400)) days${NC}"
    
    if [ "$created_timestamp" != "0" ]; then
        local created_date=$(date -d "@$created_timestamp" 2>/dev/null || echo "Unknown")
        echo -e "   Queue Created: ${YELLOW}$created_date${NC}"
    fi
    
    echo ""
    
    if [ "$available_count" -eq 0 ] && [ "$invisible_count" -eq 0 ]; then
        echo -e "${GREEN}✅ DLQ is empty${NC}"
        return 0
    fi
    
    if [ "$available_count" -gt 0 ]; then
        echo -e "${RED}⚠️  $available_count messages are available for processing${NC}"
        echo -e "${BLUE}ℹ️  Use '$0 $ENV peek' to retrieve and examine these messages${NC}"
        echo -e "${BLUE}ℹ️  Use '$0 $ENV drain' to permanently remove all messages (slow)${NC}"
        echo -e "${PURPLE}ℹ️  Use '$0 $ENV purge' to instantly delete all messages (fast)${NC}"
    fi
    
    if [ "$invisible_count" -gt 0 ]; then
        echo -e "${YELLOW}⚠️  $invisible_count messages are currently being processed or recently retrieved${NC}"
        echo -e "${BLUE}ℹ️  These will become visible again after the visibility timeout${NC}"
    fi
    
    # Show when the alarm would trigger
    if [ "$available_count" -gt 0 ]; then
        echo ""
        echo -e "${RED}🚨 DLQ Alarm Status: ACTIVE${NC}"
        echo -e "${BLUE}ℹ️  The DLQ alarm triggers when messages are present${NC}"
        echo -e "${BLUE}ℹ️  This indicates that job processing is failing${NC}"
    fi
}

# Function to peek at DLQ messages without removing them
peek_dlq_messages() {
    local queue_url=$(get_queue_url "$DLQ_NAME")
    if [ -z "$queue_url" ]; then
        echo -e "${RED}❌ DLQ not found: $DLQ_NAME${NC}"
        return 1
    fi
    
    echo -e "${BLUE}👀 Peeking at DLQ messages (not removing them)...${NC}"
    
    # First, check the queue attributes to get the actual message count
    local attrs=$(get_queue_attributes "$queue_url")
    local available_count=$(echo "$attrs" | jq -r '.Attributes.ApproximateNumberOfMessages // "0"')
    local invisible_count=$(echo "$attrs" | jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible // "0"')
    local visibility_timeout=$(echo "$attrs" | jq -r '.Attributes.VisibilityTimeout // "30"')
    
    echo -e "${BLUE}📊 Queue Status:${NC}"
    echo -e "   Available Messages: ${YELLOW}$available_count${NC}"
    echo -e "   In-Flight Messages: ${YELLOW}$invisible_count${NC}"
    echo -e "   Visibility Timeout: ${YELLOW}${visibility_timeout}s${NC}"
    echo ""
    
    if [ "$available_count" -eq 0 ]; then
        if [ "$invisible_count" -gt 0 ]; then
            echo -e "${YELLOW}⚠️  No messages currently visible, but $invisible_count messages are in-flight${NC}"
            echo -e "${BLUE}ℹ️  In-flight messages will become visible again after the visibility timeout${NC}"
        else
            echo -e "${GREEN}✅ No messages in DLQ${NC}"
        fi
        return 0
    fi
    
    echo -e "${BLUE}🔄 Retrieving messages (using long polling for better results)...${NC}"
    
    local all_messages=""
    local retrieved_count=0
    local max_attempts=5
    local attempt=1
    
    # Use multiple calls to retrieve all available messages
    while [ $attempt -le $max_attempts ] && [ $retrieved_count -lt $available_count ]; do
        echo -e "${BLUE}   Attempt $attempt/$max_attempts - Retrieved: $retrieved_count/$available_count${NC}"
        
        # Use long polling (20 seconds) and request up to 10 messages
        local messages
        if [ "$ENV" = "local" ]; then
            messages=$(aws sqs receive-message \
                --queue-url "$queue_url" \
                --max-number-of-messages 10 \
                --wait-time-seconds 20 \
                --visibility-timeout 10 \
                --endpoint-url=$AWS_ENDPOINT_URL \
                --output json 2>/dev/null || echo "{}")
        else
            messages=$(aws sqs receive-message \
                --queue-url "$queue_url" \
                --max-number-of-messages 10 \
                --wait-time-seconds 20 \
                --visibility-timeout 10 \
                --region us-east-1 \
                --output json 2>/dev/null || echo "{}")
        fi
        
        if [ "$messages" == "null" ] || [ -z "$messages" ] || [ "$messages" == "{}" ]; then
            echo -e "${YELLOW}   No messages retrieved in this attempt${NC}"
        else
            local batch_count=$(echo "$messages" | jq -r '.Messages | length // 0')
            if [ "$batch_count" -gt 0 ]; then
                echo -e "${GREEN}   Retrieved $batch_count messages in this batch${NC}"
                retrieved_count=$((retrieved_count + batch_count))
                
                # Collect all messages for display
                if [ -z "$all_messages" ]; then
                    all_messages="$messages"
                else
                    # Merge the Messages arrays
                    all_messages=$(echo "$all_messages" "$messages" | jq -s '.[0].Messages += .[1].Messages | .[0]')
                fi
            else
                echo -e "${YELLOW}   No messages in this batch${NC}"
            fi
        fi
        
        attempt=$((attempt + 1))
        
        # Short delay between attempts to avoid overwhelming the queue
        if [ $attempt -le $max_attempts ] && [ $retrieved_count -lt $available_count ]; then
            sleep 1
        fi
    done
    
    echo ""
    
    if [ -z "$all_messages" ] || [ "$all_messages" == "{}" ]; then
        echo -e "${YELLOW}⚠️  No messages were retrieved despite queue showing $available_count available${NC}"
        echo -e "${BLUE}ℹ️  This might be due to:${NC}"
        echo -e "     - Messages became in-flight during retrieval${NC}"
        echo -e "     - SQS short polling behavior${NC}"
        echo -e "     - Messages being processed by other consumers${NC}"
        return 0
    fi
    
    echo -e "${GREEN}✅ Successfully retrieved $retrieved_count messages:${NC}"
    echo ""
    
    # Display all retrieved messages with enhanced formatting
    echo "$all_messages" | jq -r '.Messages[]? | 
        "📝 Message ID: \(.MessageId)" + 
        "\n   📤 Body: \(.Body)" + 
        "\n   📋 Attributes: \(.Attributes // {})" + 
        (if .Attributes.ApproximateReceiveCount then "\n   🔄 Receive Count: \(.Attributes.ApproximateReceiveCount)" else "" end) +
        (if .Attributes.SentTimestamp then "\n   🕐 Sent: " + (.Attributes.SentTimestamp | tonumber / 1000 | strftime("%Y-%m-%d %H:%M:%S UTC")) else "" end) +
        "\n   🎫 Receipt Handle: \(.ReceiptHandle[0:50])..." +
        "\n"'
    
    # Important note about message visibility
    echo -e "${YELLOW}⚠️  NOTE: These messages are now temporarily invisible (visibility timeout: 10s)${NC}"
    echo -e "${BLUE}ℹ️  They will become visible again automatically and can be processed by workers${NC}"
    echo -e "${BLUE}ℹ️  To permanently remove messages, use: $0 $ENV drain or $0 $ENV purge${NC}"
}

# Function to purge DLQ messages (AWS native purge operation - instant)
purge_dlq_messages() {
    local queue_url=$(get_queue_url "$DLQ_NAME")
    if [ -z "$queue_url" ]; then
        echo -e "${RED}❌ DLQ not found: $DLQ_NAME${NC}"
        return 1
    fi
    
    # Get initial message count
    local attrs=$(get_queue_attributes "$queue_url")
    local initial_available=$(echo "$attrs" | jq -r '.Attributes.ApproximateNumberOfMessages // "0"')
    local initial_invisible=$(echo "$attrs" | jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible // "0"')
    local initial_total=$((initial_available + initial_invisible))
    
    echo -e "${PURPLE}🗑️  AWS SQS Queue Purge Operation${NC}"
    echo -e "${BLUE}📊 Current DLQ Status:${NC}"
    echo -e "   Available Messages: ${YELLOW}$initial_available${NC}"
    echo -e "   In-Flight Messages: ${YELLOW}$initial_invisible${NC}"
    echo -e "   Total Messages: ${YELLOW}$initial_total${NC}"
    echo ""
    
    if [ "$initial_total" -eq 0 ]; then
        echo -e "${GREEN}✅ DLQ is already empty${NC}"
        return 0
    fi
    
    echo -e "${PURPLE}💫 FAST PURGE: This will use AWS native purge operation${NC}"
    echo -e "${YELLOW}⚠️  This will INSTANTLY delete ALL messages in the DLQ (both visible and in-flight)${NC}"
    echo -e "${YELLOW}⚠️  This operation cannot be undone and completes within seconds${NC}"
    echo -e "${YELLOW}⚠️  Continue with fast purge? (y/N)${NC}"
    read -r confirmation
    if [[ ! "$confirmation" =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}ℹ️  Operation cancelled${NC}"
        echo -e "${BLUE}ℹ️  Tip: Use '$0 $ENV drain' for slower message-by-message deletion${NC}"
        return 0
    fi
    
    echo -e "${PURPLE}⚡ Executing AWS SQS purge operation...${NC}"
    
    # Execute the purge operation
    local purge_result
    if purge_result=$(purge_queue "$queue_url" 2>&1); then
        echo -e "${GREEN}✅ Purge operation initiated successfully${NC}"
        
        # AWS purge operations take up to 60 seconds to complete
        echo -e "${BLUE}ℹ️  Purge operation is in progress (can take up to 60 seconds)${NC}"
        echo -e "${BLUE}ℹ️  Checking queue status in 10 seconds...${NC}"
        
        sleep 10
        
        # Check final status
        local final_attrs=$(get_queue_attributes "$queue_url")
        local final_available=$(echo "$final_attrs" | jq -r '.Attributes.ApproximateNumberOfMessages // "0"')
        local final_invisible=$(echo "$final_attrs" | jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible // "0"')
        local final_total=$((final_available + final_invisible))
        
        echo ""
        echo -e "${BLUE}📊 Queue Status After Purge:${NC}"
        echo -e "   Available Messages: ${YELLOW}$final_available${NC}"
        echo -e "   In-Flight Messages: ${YELLOW}$final_invisible${NC}"
        echo -e "   Total Messages: ${YELLOW}$final_total${NC}"
        
        if [ "$final_total" -eq 0 ]; then
            echo -e "${GREEN}🎉 Queue successfully purged! All messages removed.${NC}"
            echo -e "${BLUE}ℹ️  DLQ alarm should clear within 5-10 minutes${NC}"
        else
            echo -e "${YELLOW}⚠️  Purge may still be in progress...${NC}"
            echo -e "${BLUE}ℹ️  AWS purge operations can take up to 60 seconds to complete${NC}"
            echo -e "${BLUE}ℹ️  Check again in a few minutes: $0 $ENV status${NC}"
        fi
        
    else
        echo -e "${RED}❌ Purge operation failed:${NC}"
        echo -e "${YELLOW}$purge_result${NC}"
        
        # Check if it's a rate limiting issue
        if echo "$purge_result" | grep -q "PurgeQueueInProgress\|QueueDoesNotExist\|AWS.SimpleQueueService.QueueDoesNotExist"; then
            echo -e "${BLUE}ℹ️  This might be due to:${NC}"
            echo -e "     - Another purge operation already in progress${NC}"
            echo -e "     - Queue was recently purged (must wait 60 seconds between purges)${NC}"
            echo -e "     - Queue doesn't exist or no permissions${NC}"
        fi
        
        echo -e "${BLUE}ℹ️  Alternative: Use '$0 $ENV drain' for message-by-message deletion${NC}"
        return 1
    fi
}

# Function to drain DLQ messages (receive and delete them one by one - slower but more reliable)
drain_dlq_messages() {
    local queue_url=$(get_queue_url "$DLQ_NAME")
    if [ -z "$queue_url" ]; then
        echo -e "${RED}❌ DLQ not found: $DLQ_NAME${NC}"
        return 1
    fi
    
    # Get initial message count
    local attrs=$(get_queue_attributes "$queue_url")
    local initial_available=$(echo "$attrs" | jq -r '.Attributes.ApproximateNumberOfMessages // "0"')
    local initial_invisible=$(echo "$attrs" | jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible // "0"')
    local initial_total=$((initial_available + initial_invisible))
    
    echo -e "${BLUE}🔄 Message-by-Message Drain Operation${NC}"
    echo -e "${BLUE}📊 Initial DLQ Status:${NC}"
    echo -e "   Available Messages: ${YELLOW}$initial_available${NC}"
    echo -e "   In-Flight Messages: ${YELLOW}$initial_invisible${NC}"
    echo -e "   Total Messages: ${YELLOW}$initial_total${NC}"
    echo ""
    
    if [ "$initial_total" -eq 0 ]; then
        echo -e "${GREEN}✅ DLQ is already empty${NC}"
        return 0
    fi
    
    echo -e "${BLUE}🐌 SLOW DRAIN: This will retrieve and delete messages one by one${NC}"
    echo -e "${YELLOW}⚠️  This will permanently delete ALL messages in the DLQ.${NC}"
    echo -e "${YELLOW}⚠️  Messages that are currently in-flight will also be deleted when they become visible.${NC}"
    echo -e "${YELLOW}⚠️  Continue with slow drain? (y/N)${NC}"
    echo -e "${PURPLE}💡 Tip: Use '$0 $ENV purge' for instant deletion${NC}"
    read -r confirmation
    if [[ ! "$confirmation" =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}ℹ️  Operation cancelled${NC}"
        return 0
    fi
    
    echo -e "${RED}🗑️  Draining DLQ messages...${NC}"
    
    local drained_count=0
    local max_attempts=10
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        echo -e "${BLUE}   Drain attempt $attempt/$max_attempts...${NC}"
        
        local messages=$(receive_messages "$queue_url" 10)
        
        if [ "$messages" == "null" ] || [ -z "$messages" ] || [ "$messages" == "{}" ]; then
            echo -e "${YELLOW}   No messages retrieved in this attempt${NC}"
            
            # Check if there are still messages in the queue
            local current_attrs=$(get_queue_attributes "$queue_url" "ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible")
            local current_available=$(echo "$current_attrs" | jq -r '.Attributes.ApproximateNumberOfMessages // "0"')
            local current_invisible=$(echo "$current_attrs" | jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible // "0"')
            local current_total=$((current_available + current_invisible))
            
            if [ "$current_total" -eq 0 ]; then
                echo -e "${GREEN}   ✅ No more messages in queue${NC}"
                break
            elif [ "$current_invisible" -gt 0 ]; then
                echo -e "${YELLOW}   ⏳ Waiting for $current_invisible in-flight messages to become visible...${NC}"
                sleep 5
            else
                echo -e "${YELLOW}   ⏳ Waiting for messages to become available...${NC}"
                sleep 2
            fi
        else
            local batch_count=$(echo "$messages" | jq -r '.Messages | length // 0')
            if [ "$batch_count" -gt 0 ]; then
                echo -e "${GREEN}   Retrieved $batch_count messages for deletion${NC}"
                
                # Delete each message
                local deleted_in_batch=0
                echo "$messages" | jq -r '.Messages[]? | .ReceiptHandle' | while read -r receipt_handle; do
                    if [ -n "$receipt_handle" ]; then
                        if delete_message "$queue_url" "$receipt_handle"; then
                            deleted_in_batch=$((deleted_in_batch + 1))
                        fi
                    fi
                done
                
                drained_count=$((drained_count + batch_count))
                echo -e "${GREEN}   ✅ Deleted $batch_count messages (total: $drained_count)${NC}"
            fi
        fi
        
        attempt=$((attempt + 1))
        
        # Short delay between attempts
        if [ $attempt -le $max_attempts ]; then
            sleep 1
        fi
    done
    
    # Final status check
    local final_attrs=$(get_queue_attributes "$queue_url" "ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible")
    local final_available=$(echo "$final_attrs" | jq -r '.Attributes.ApproximateNumberOfMessages // "0"')
    local final_invisible=$(echo "$final_attrs" | jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible // "0"')
    local final_total=$((final_available + final_invisible))
    
    echo ""
    echo -e "${BLUE}📊 Final DLQ Status:${NC}"
    echo -e "   Available Messages: ${YELLOW}$final_available${NC}"
    echo -e "   In-Flight Messages: ${YELLOW}$final_invisible${NC}"
    echo -e "   Total Messages: ${YELLOW}$final_total${NC}"
    echo -e "   Messages Drained: ${GREEN}$drained_count${NC}"
    
    if [ "$final_total" -eq 0 ]; then
        echo -e "${GREEN}✅ Successfully drained all messages from DLQ${NC}"
        echo -e "${BLUE}ℹ️  DLQ alarm should clear shortly${NC}"
    else
        echo -e "${YELLOW}⚠️  $final_total messages remain in DLQ${NC}"
        if [ "$final_invisible" -gt 0 ]; then
            echo -e "${BLUE}ℹ️  $final_invisible messages are in-flight and will become visible again${NC}"
            echo -e "${BLUE}ℹ️  You may need to run drain again to remove them${NC}"
        fi
        echo -e "${PURPLE}💡 Tip: Use '$0 $ENV purge' for instant deletion of remaining messages${NC}"
    fi
}

# Function to show queue attributes for all queues
show_queue_stats() {
    echo -e "${BLUE}📊 Queue Statistics:${NC}"
    
    # Use different queue naming for AWS vs local
    if [ "$ENV" = "local" ]; then
        local queues=("v3-backend-${ENV}-background-job-queue" "v3-backend-${ENV}-data-refresh-queue" "v3-backend-${ENV}-notification-queue" "$DLQ_NAME")
    else
        local queues=("v3-backend-${ENV}-background-job-queue" "v3-backend-${ENV}-data-refresh-queue" "v3-backend-${ENV}-notification-queue" "v3-backend-${ENV}-background-job-dlq" "v3-backend-${ENV}-data-refresh-dlq" "v3-backend-${ENV}-notification-dlq")
    fi
    
    for queue_name in "${queues[@]}"; do
        local queue_url=$(get_queue_url "$queue_name")
        if [ -n "$queue_url" ]; then
            local attrs=$(get_queue_attributes "$queue_url")
            
            local visible=$(echo "$attrs" | jq -r '.Attributes.ApproximateNumberOfMessages // "0"')
            local invisible=$(echo "$attrs" | jq -r '.Attributes.ApproximateNumberOfMessagesNotVisible // "0"')
            local redrive=$(echo "$attrs" | jq -r '.Attributes.RedrivePolicy // "none"')
            
            echo -e "  ${YELLOW}$queue_name:${NC}"
            echo -e "    Visible Messages: $visible"
            echo -e "    Processing Messages: $invisible"
            if [ "$redrive" != "none" ]; then
                local max_receives=$(echo "$redrive" | jq -r '.maxReceiveCount')
                echo -e "    DLQ Max Retries: $max_receives"
            else
                echo -e "    DLQ Policy: none"
            fi
            echo ""
        fi
    done
}

# Function to simulate a failed message (for testing DLQ)
simulate_failed_message() {
    echo -e "${YELLOW}🧪 Simulating a failed message for DLQ testing...${NC}"
    
    local queue_url=$(get_queue_url "v3-backend-${ENV}-background-job-queue")
    if [ -z "$queue_url" ]; then
        echo -e "${RED}❌ Background job queue not found${NC}"
        return 1
    fi
    
    # Send an invalid job message that will likely fail processing
    local test_message='{"name":"test-dlq-message","chain":"INVALID_CHAIN","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
    
    if [ "$ENV" = "local" ]; then
        aws sqs send-message \
            --queue-url "$queue_url" \
            --message-body "$test_message" \
            --endpoint-url=$AWS_ENDPOINT_URL >/dev/null
    else
        aws sqs send-message \
            --queue-url "$queue_url" \
            --message-body "$test_message" \
            --region us-east-1 >/dev/null
    fi
    
    echo -e "${GREEN}✅ Sent test message that should fail and eventually go to DLQ${NC}"
    echo -e "${BLUE}ℹ️  Monitor the worker logs and check DLQ after a few minutes${NC}"
}

# Main command handler
case "$1" in
    "count")
        check_dlq_count
        ;;
    "status")
        peek_dlq_status
        ;;
    "peek")
        peek_dlq_messages
        ;;
    "drain")
        drain_dlq_messages
        ;;
    "purge")
        purge_dlq_messages
        ;;
    "stats")
        show_queue_stats
        ;;
    "test")
        simulate_failed_message
        ;;
    *)
        echo -e "${BLUE}🔧 Enhanced DLQ Utilities for Balancer v3 Backend${NC}"
        echo ""
        echo "Usage: $0 [environment] <command>"
        echo ""
        echo "Environments:"
        echo -e "  ${YELLOW}(no env)${NC}     - LocalStack (default for local development)"
        echo -e "  ${YELLOW}aws${NC}         - AWS development environment (alias for 'development')"
        echo -e "  ${YELLOW}development${NC} - AWS development environment"
        echo -e "  ${YELLOW}staging${NC}     - AWS staging environment"
        echo -e "  ${YELLOW}production${NC}  - AWS production environment"
        echo ""
        echo "Commands:"
        echo -e "  ${YELLOW}count${NC}     - Show number of messages in DLQ"
        echo -e "  ${YELLOW}status${NC}    - Show detailed DLQ status (non-intrusive)"
        echo -e "  ${YELLOW}peek${NC}      - Retrieve and examine DLQ messages (makes them temporarily invisible)"
        echo -e "  ${YELLOW}drain${NC}     - Remove all messages from DLQ one-by-one (slow but reliable)"
        echo -e "  ${PURPLE}purge${NC}     - Instantly delete ALL messages using AWS native purge (fast)"
        echo -e "  ${YELLOW}stats${NC}     - Show statistics for all queues"
        echo -e "  ${YELLOW}test${NC}      - Send a test message that should fail to DLQ"
        echo ""
        echo "Examples:"
        echo -e "  ${BLUE}$0 count${NC}                    - Check local DLQ message count"
        echo -e "  ${BLUE}$0 development status${NC}       - Check AWS development DLQ status"
        echo -e "  ${BLUE}$0 development peek${NC}         - Examine AWS development DLQ messages"
        echo -e "  ${BLUE}$0 aws stats${NC}                - Show AWS development queue stats"
        echo -e "  ${PURPLE}$0 production purge${NC}         - Instantly clear production DLQ (fast)"
        echo -e "  ${BLUE}$0 production drain${NC}         - Slowly clear production DLQ (reliable)"
        echo ""
        echo -e "${GREEN}💡 Quick Investigation Workflow:${NC}"
        echo -e "  1. ${BLUE}$0 development status${NC}     - Check if DLQ has messages"
        echo -e "  2. ${BLUE}$0 development peek${NC}       - Examine failed message content"
        echo -e "  3. ${PURPLE}$0 development purge${NC}      - Instantly clear DLQ (recommended)"
        echo -e "  4. ${BLUE}$0 development drain${NC}      - Alternative: slower message-by-message deletion"
        echo ""
        echo -e "${PURPLE}🚀 Performance Comparison:${NC}"
        echo -e "  ${PURPLE}purge${NC} - Uses AWS native operation, completes in seconds, handles all message states"
        echo -e "  ${BLUE}drain${NC} - Retrieves and deletes messages individually, slower but more verbose"
        ;;
esac