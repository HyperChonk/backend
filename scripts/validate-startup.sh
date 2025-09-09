#!/bin/bash

# Comprehensive startup validation script for Balancer v3 Backend
# This script validates that all services are properly initialized and functional

set -e

# Configuration
API_HOST=${API_HOST:-localhost}
API_PORT=${API_PORT:-4000}
POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5431}
LOCALSTACK_HOST=${LOCALSTACK_HOST:-localhost}
LOCALSTACK_PORT=${LOCALSTACK_PORT:-4566}
REDIS_HOST=${REDIS_HOST:-localhost}
REDIS_PORT=${REDIS_PORT:-6379}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Test functions
test_postgres() {
    log_info "Testing PostgreSQL connection..."
    local max_attempts=10
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        if nc -z "$POSTGRES_HOST" "$POSTGRES_PORT" 2>/dev/null; then
            break
        fi
        echo -n "."
        sleep 1
        attempt=$((attempt + 1))
    done

    if [ $attempt -ge $max_attempts ]; then
        log_error "Cannot connect to PostgreSQL at $POSTGRES_HOST:$POSTGRES_PORT after $max_attempts attempts"
        return 1
    fi
    
    if ! PGPASSWORD=let-me-in psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U backend -d database -c "SELECT 1;" >/dev/null 2>&1; then
        log_error "PostgreSQL connection test failed"
        return 1
    fi
    
    # Test if tables exist (basic schema check)
    local table_count
    table_count=$(PGPASSWORD=let-me-in psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U backend -d database -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' ')
    
    if [ "$table_count" -gt 0 ]; then
        log_success "PostgreSQL is ready with $table_count tables in schema"
    else
        log_warning "PostgreSQL is connected but no tables found (migrations may not have run)"
    fi
    
    return 0
}

test_redis() {
    log_info "Testing Redis connection..."
    
    if ! nc -z "$REDIS_HOST" "$REDIS_PORT" 2>/dev/null; then
        log_error "Cannot connect to Redis at $REDIS_HOST:$REDIS_PORT"
        return 1
    fi
    
    # Try redis-cli first, fallback to Docker exec if redis-cli not available
    if command -v redis-cli >/dev/null 2>&1; then
        if ! redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
            log_error "Redis ping failed"
            return 1
        fi
    else
        # Use Docker to test Redis if redis-cli not available on host
        if ! docker compose exec -T redis redis-cli ping >/dev/null 2>&1; then
            log_error "Redis ping failed"
            return 1
        fi
    fi
    
    log_success "Redis is ready and responsive"
    return 0
}

test_localstack() {
    log_info "Testing LocalStack services..."
    local max_attempts=10
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        # Use -s to silence progress meter, and --fail to exit with non-zero on server error
        if curl -s --fail "http://$LOCALSTACK_HOST:$LOCALSTACK_PORT/_localstack/health" >/dev/null 2>&1; then
            break
        fi
        echo -n "."
        sleep 1
        attempt=$((attempt + 1))
    done
    
    if [ $attempt -ge $max_attempts ]; then
        log_error "LocalStack health endpoint not accessible after $max_attempts attempts"
        return 1
    fi
    
    # Check specific services
    local health_response
    health_response=$(curl -s "http://$LOCALSTACK_HOST:$LOCALSTACK_PORT/_localstack/health" 2>/dev/null || echo "")
    
    if [ -z "$health_response" ]; then
        log_error "Cannot retrieve LocalStack health status"
        return 1
    fi
    
    # Validate critical services
    local services=("sqs" "s3" "secretsmanager" "ssm" "logs" "sns")
    local failed_services=()
    
    for service in "${services[@]}"; do
        # Check for both "available" and "running" status (LocalStack can return either)
        if echo "$health_response" | grep -q "\"$service\": \"available\"" || echo "$health_response" | grep -q "\"$service\": \"running\""; then
            log_success "LocalStack $service is available"
        else
            failed_services+=("$service")
            log_error "LocalStack $service is not available"
        fi
    done
    
    if [ ${#failed_services[@]} -gt 0 ]; then
        log_error "LocalStack services not ready: ${failed_services[*]}"
        return 1
    fi
    
    # Test SQS functionality
    log_info "Testing SQS queue access..."
    if AWS_ENDPOINT_URL="http://$LOCALSTACK_HOST:$LOCALSTACK_PORT" AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
       aws sqs list-queues --region us-east-1 >/dev/null 2>&1; then
        log_success "SQS queues are accessible"
    else
        log_error "SQS functionality test failed"
        return 1
    fi
    
    return 0
}

test_api() {
    log_info "Testing API service..."
    
    # Test health endpoint
    if ! curl -f "http://$API_HOST:$API_PORT/health" >/dev/null 2>&1; then
        log_error "API health endpoint not accessible at http://$API_HOST:$API_PORT/health"
        return 1
    fi
    
    log_success "API health endpoint is responsive"
    
    # Test GraphQL endpoint
    log_info "Testing GraphQL endpoint..."
    local graphql_response
    graphql_response=$(curl -s -f "http://$API_HOST:$API_PORT/graphql" \
        -H "Content-Type: application/json" \
        -d '{"query":"{ __typename }"}' 2>/dev/null || echo "")
    
    if [ -z "$graphql_response" ]; then
        log_error "GraphQL endpoint not accessible"
        return 1
    fi
    
    if echo "$graphql_response" | grep -q '"data"'; then
        log_success "GraphQL endpoint is functional"
    else
        log_error "GraphQL endpoint returned unexpected response: $graphql_response"
        return 1
    fi
    
    # Test a basic query
    log_info "Testing basic GraphQL query..."
    local pools_response
    pools_response=$(curl -s -f "http://$API_HOST:$API_PORT/graphql" \
        -H "Content-Type: application/json" \
        -H "chainId: 999" \
        -d '{"query":"{ poolGetPools(first: 1) { id name } }"}' 2>/dev/null || echo "")
    
    if echo "$pools_response" | grep -q '"poolGetPools"'; then
        log_success "Basic GraphQL query successful"
    else
        log_warning "Basic GraphQL query failed or returned no pools"
        log_info "Response: $pools_response"
    fi
    
    return 0
}

test_docker_services() {
    log_info "Checking Docker container status..."
    
    local containers=("balancer-postgres" "balancer-redis" "balancer-localstack" "balancer-api" "balancer-worker" "balancer-scheduler")
    local failed_containers=()
    
    for container in "${containers[@]}"; do
        if docker ps --format "table {{.Names}}" | grep -q "^$container$"; then
            local status
            status=$(docker inspect "$container" --format='{{.State.Status}}' 2>/dev/null || echo "unknown")
            if [ "$status" = "running" ]; then
                log_success "Container $container is running"
            else
                log_error "Container $container is not running (status: $status)"
                failed_containers+=("$container")
            fi
        else
            log_error "Container $container not found"
            failed_containers+=("$container")
        fi
    done
    
    if [ ${#failed_containers[@]} -gt 0 ]; then
        log_error "Failed containers: ${failed_containers[*]}"
        return 1
    fi
    
    return 0
}

test_environment_variables() {
    log_info "Validating environment configuration..."
    
    # Check if running in development mode
    if [ "${NODE_ENV:-}" = "development" ] || [ "${DEPLOYMENT_ENV:-}" = "local" ]; then
        log_success "Development environment detected"
    else
        log_warning "Environment variables suggest non-development setup"
    fi
    
    # For Docker environment, DATABASE_URL is not required on host since containers use their own env vars
    # Check if we're in Docker context
    if docker compose ps >/dev/null 2>&1; then
        log_success "Docker environment detected - containers manage their own environment variables"
    else
        # Check critical environment variables for non-Docker deployments
        local required_vars=("DATABASE_URL")
        local missing_vars=()
        
        for var in "${required_vars[@]}"; do
            if [ -z "${!var:-}" ]; then
                missing_vars+=("$var")
            fi
        done
        
        if [ ${#missing_vars[@]} -gt 0 ]; then
            log_warning "Missing environment variables: ${missing_vars[*]}"
        else
            log_success "Required environment variables are set"
        fi
    fi
    
    return 0
}

# Main validation function
run_validation() {
    echo "🔍 Starting comprehensive startup validation..."
    echo "================================================"
    
    local failed_tests=()
    
    # Test each component
    if ! test_docker_services; then
        failed_tests+=("docker_services")
    fi
    
    echo ""
    
    if ! test_postgres; then
        failed_tests+=("postgres")
    fi
    
    echo ""
    
    if ! test_redis; then
        failed_tests+=("redis")
    fi
    
    echo ""
    
    if ! test_localstack; then
        failed_tests+=("localstack")
    fi
    
    echo ""
    
    if ! test_api; then
        failed_tests+=("api")
    fi
    
    echo ""
    
    test_environment_variables
    
    echo ""
    echo "================================================"
    
    # Check if critical services are working (API and database are essential)
    local critical_failures=()
    for test in "${failed_tests[@]}"; do
        if [[ "$test" == "docker_services" || "$test" == "postgres" || "$test" == "api" ]]; then
            critical_failures+=("$test")
        fi
    done
    
    if [ ${#critical_failures[@]} -eq 0 ]; then
        if [ ${#failed_tests[@]} -eq 0 ]; then
            log_success "🎉 All validation tests passed!"
        else
            log_warning "⚠️  Some validation tests failed, but services are running"
            log_info "Failed tests (non-critical): ${failed_tests[*]}"
        fi
        log_info "Your Balancer v3 Backend development environment is ready!"
        echo ""
        log_info "🔗 Available endpoints:"
        log_info "   • API Health: http://$API_HOST:$API_PORT/health"
        log_info "   • GraphQL Playground: http://$API_HOST:$API_PORT/graphql"
        log_info "   • LocalStack: http://$LOCALSTACK_HOST:$LOCALSTACK_PORT"
        log_info "   • PostgreSQL: $POSTGRES_HOST:$POSTGRES_PORT"
        log_info "   • Redis: $REDIS_HOST:$REDIS_PORT"
        echo ""
        if [ ${#failed_tests[@]} -gt 0 ]; then
            log_info "Run './scripts/start-local.sh validate' for detailed diagnostics"
        fi
        return 0
    else
        log_error "❌ Validation failed for: ${failed_tests[*]}"
        log_info "Please check the logs above for specific issues"
        return 1
    fi
}

# Help function
show_help() {
    echo "Balancer v3 Backend Startup Validation Script"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -h, --help          Show this help message"
    echo "  --api-host HOST     API host (default: localhost)"
    echo "  --api-port PORT     API port (default: 4000)"
    echo "  --postgres-host HOST Postgres host (default: localhost)"
    echo "  --postgres-port PORT Postgres port (default: 5431)"
    echo "  --localstack-host HOST LocalStack host (default: localhost)"
    echo "  --localstack-port PORT LocalStack port (default: 4566)"
    echo "  --redis-host HOST   Redis host (default: localhost)"
    echo "  --redis-port PORT   Redis port (default: 6379)"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Validate with default settings"
    echo "  $0 --api-port 3000                  # Use custom API port"
    echo "  $0 --postgres-host db.example.com   # Use remote database"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        --api-host)
            API_HOST="$2"
            shift 2
            ;;
        --api-port)
            API_PORT="$2"
            shift 2
            ;;
        --postgres-host)
            POSTGRES_HOST="$2"
            shift 2
            ;;
        --postgres-port)
            POSTGRES_PORT="$2"
            shift 2
            ;;
        --localstack-host)
            LOCALSTACK_HOST="$2"
            shift 2
            ;;
        --localstack-port)
            LOCALSTACK_PORT="$2"
            shift 2
            ;;
        --redis-host)
            REDIS_HOST="$2"
            shift 2
            ;;
        --redis-port)
            REDIS_PORT="$2"
            shift 2
            ;;
        *)
            log_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Run the validation
run_validation 
