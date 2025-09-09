#!/bin/bash

# Enhanced service readiness checker for Docker Compose orchestration
# This script provides more robust service dependency management

set -e

# Configuration
MAX_WAIT_TIME=300  # 5 minutes total
CHECK_INTERVAL=5   # Check every 5 seconds
VERBOSE=${VERBOSE:-1}

# Logging functions
log() {
    if [ "$VERBOSE" -eq 1 ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    fi
}

error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1" >&2
}

# Service check functions
check_postgres() {
    local host=${1:-postgres}
    local port=${2:-5432}
    local user=${3:-backend}
    local db=${4:-database}
    
    log "🔍 Checking PostgreSQL at $host:$port..."
    
    # Test basic connection
    if ! nc -z "$host" "$port" 2>/dev/null; then
        return 1
    fi
    
    # Test database readiness with actual query
    if ! PGPASSWORD=let-me-in psql -h "$host" -p "$port" -U "$user" -d "$db" -c "SELECT 1;" >/dev/null 2>&1; then
        return 1
    fi
    
    log "✅ PostgreSQL is ready"
    return 0
}

check_localstack() {
    local host=${1:-localstack}
    local port=${2:-4566}
    
    log "🔍 Checking LocalStack at $host:$port..."
    
    # Test basic connectivity
    if ! curl -f "http://$host:$port/_localstack/health" >/dev/null 2>&1; then
        return 1
    fi
    
    # Test specific services
    local health_response
    health_response=$(curl -s "http://$host:$port/_localstack/health" 2>/dev/null || echo "")
    
    if [ -z "$health_response" ]; then
        return 1
    fi
    
    # Check critical services
    if ! echo "$health_response" | grep -q '"sqs": "available"'; then
        log "⚠️  SQS not available yet"
        return 1
    fi
    
    if ! echo "$health_response" | grep -q '"s3": "available"'; then
        log "⚠️  S3 not available yet"
        return 1
    fi
    
    # Test actual SQS functionality
    if ! AWS_ENDPOINT_URL="http://$host:$port" AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
         aws sqs list-queues --region us-east-1 >/dev/null 2>&1; then
        log "⚠️  SQS not functional yet"
        return 1
    fi
    
    log "✅ LocalStack is ready and functional"
    return 0
}

check_api() {
    local host=${1:-api}
    local port=${2:-4000}
    
    log "🔍 Checking API at $host:$port..."
    
    # Test health endpoint
    if ! curl -f "http://$host:$port/health" >/dev/null 2>&1; then
        return 1
    fi
    
    # Test GraphQL endpoint
    if ! curl -f "http://$host:$port/graphql" \
         -H "Content-Type: application/json" \
         -d '{"query":"{ __typename }"}' >/dev/null 2>&1; then
        return 1
    fi
    
    log "✅ API is ready"
    return 0
}

check_redis() {
    local host=${1:-redis}
    local port=${2:-6379}
    
    log "🔍 Checking Redis at $host:$port..."
    
    if ! redis-cli -h "$host" -p "$port" ping >/dev/null 2>&1; then
        return 1
    fi
    
    log "✅ Redis is ready"
    return 0
}

# Generic service checker
check_service() {
    local service_type=$1
    shift  # Remove first argument, rest are passed to specific check function
    
    case $service_type in
        "postgres")
            check_postgres "$@"
            ;;
        "localstack")
            check_localstack "$@"
            ;;
        "api")
            check_api "$@"
            ;;
        "redis")
            check_redis "$@"
            ;;
        *)
            error "Unknown service type: $service_type"
            return 1
            ;;
    esac
}

# Wait for multiple services
wait_for_services() {
    local services=("$@")
    local start_time=$(date +%s)
    local all_ready=false
    
    log "🕐 Waiting for services: ${services[*]}"
    log "⏱️  Maximum wait time: ${MAX_WAIT_TIME}s"
    
    while [ "$all_ready" = false ]; do
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))
        
        if [ $elapsed -gt $MAX_WAIT_TIME ]; then
            error "Timeout after ${MAX_WAIT_TIME}s waiting for services: ${services[*]}"
            return 1
        fi
        
        all_ready=true
        
        for service_spec in "${services[@]}"; do
            # Parse service specification (format: type:host:port or just type)
            IFS=':' read -ra service_parts <<< "$service_spec"
            local service_type="${service_parts[0]}"
            local service_host="${service_parts[1]:-$service_type}"
            local service_port="${service_parts[2]:-}"
            
            if ! check_service "$service_type" "$service_host" "$service_port"; then
                all_ready=false
                break
            fi
        done
        
        if [ "$all_ready" = false ]; then
            log "⏳ Some services not ready yet, waiting ${CHECK_INTERVAL}s... (${elapsed}s elapsed)"
            sleep $CHECK_INTERVAL
        fi
    done
    
    log "🎉 All services are ready!"
    return 0
}

# Main execution
main() {
    if [ $# -eq 0 ]; then
        echo "Usage: $0 <service1> [service2] [service3] ..."
        echo ""
        echo "Service formats:"
        echo "  postgres[:host[:port]]     - PostgreSQL database"
        echo "  localstack[:host[:port]]   - LocalStack AWS services"
        echo "  api[:host[:port]]          - Main API service"
        echo "  redis[:host[:port]]        - Redis cache"
        echo ""
        echo "Examples:"
        echo "  $0 postgres localstack"
        echo "  $0 postgres:postgres:5432 localstack:localstack:4566"
        echo "  $0 postgres localstack api"
        echo ""
        echo "Environment variables:"
        echo "  VERBOSE=0|1    - Enable/disable verbose logging (default: 1)"
        exit 1
    fi
    
    wait_for_services "$@"
}

# Run main function if script is executed directly
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi 
