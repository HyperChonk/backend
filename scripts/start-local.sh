#!/bin/bash

# Local Development Environment Startup Script
# This script starts all services and ensures they're healthy

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
COMPOSE_FILE="docker-compose.yml"
DEV_MODE=false

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if a service is healthy
check_service_health() {
    local service_name=$1
    local max_attempts=30
    local attempt=0

    print_status "Waiting for $service_name to be healthy..."

    while [ $attempt -lt $max_attempts ]; do
        if docker compose ps | grep -q "$service_name.*healthy"; then
            print_success "$service_name is healthy!"
            return 0
        fi

        if docker compose ps | grep -q "$service_name.*unhealthy"; then
            print_error "$service_name is unhealthy!"
            docker compose logs --tail=20 $service_name
            return 1
        fi

        # Check if service is running (for services without health checks)
        if docker compose ps | grep -q "$service_name.*Up"; then
            local running_time=$(docker compose ps | grep "$service_name" | awk '{print $4}')
            if [[ "$running_time" =~ minutes|hours|days ]]; then
                print_success "$service_name is running!"
                return 0
            fi
        fi

        attempt=$((attempt + 1))
        echo -n "."
        sleep 2
    done

    print_error "$service_name health check timed out"
    return 1
}

# Function to wait for LocalStack to be ready
wait_for_localstack() {
    print_status "Waiting for LocalStack to initialize AWS resources..."
    
    # Wait for LocalStack to be healthy first
    check_service_health "balancer-localstack"
    
    # Additional wait for initialization script to complete
    print_status "Waiting for AWS resource initialization..."
    sleep 15
    
    # Check if SQS queues were created successfully
    if docker compose exec -T localstack awslocal sqs list-queues 2>/dev/null | grep -q "v3-backend-local"; then
        print_success "LocalStack AWS resources initialized successfully!"
    else
        print_warning "LocalStack AWS resources may not be fully initialized"
        print_status "Checking LocalStack logs for errors..."
        docker compose logs --tail=30 localstack | grep -E "(ERROR|WARN|Failed)" || true
        print_status "You can check full LocalStack logs with: docker compose logs localstack"
    fi
}

# Function to run database migrations
run_migrations() {
    print_status "Running database migrations..."
    
    # Wait for PostgreSQL to be ready
    check_service_health "balancer-postgres"
    
    # Wait a bit more for API service to be ready
    print_status "Waiting for API service to be ready for migrations..."
    sleep 10
    
    # Run Prisma migrations
    if docker compose exec -T api bun prisma db push --accept-data-loss; then
        print_success "Database migrations completed!"
    else
        print_error "Database migrations failed!"
        print_status "Checking database connection..."
        docker compose exec -T api bun prisma db pull --force || true
        return 1
    fi
}

# Function to show service status
show_status() {
    echo ""
    print_status "=== Service Status ==="
    docker compose ps
    echo ""
    
    print_status "=== Available Endpoints ==="
    echo "🌐 API (GraphQL):     http://localhost:4000/graphql"
    echo "🏥 API Health:        http://localhost:4000/health"
    echo "📊 LocalStack:        http://localhost:4566"
    echo "🗄️  PostgreSQL:       localhost:5432"
    echo "🔴 Redis:             localhost:6379"
    echo ""
    
    print_status "=== Useful Commands ==="
    echo "📋 View logs:         docker compose logs -f [service]"
    echo "🔧 Execute commands:  docker compose exec [service] [command]"
    echo "⏹️  Stop services:     ./scripts/start-local.sh stop"
    echo "🧹 Clean volumes:     ./scripts/start-local.sh clean"
    echo "💥 Complete wipe:     ./scripts/start-local.sh wipe"
    echo "🔧 Development mode:  ./scripts/start-local.sh dev"
    echo ""
}

# Function to setup compose file arguments
setup_compose_args() {
    if [ "$DEV_MODE" = true ]; then
        COMPOSE_ARGS="-f docker-compose.yml -f docker-compose.dev.yml"
        print_status "Using development mode with hot reloading"
    else
        COMPOSE_ARGS="-f docker-compose.yml"
        print_status "Using production mode"
    fi
}

# Main execution
main() {
    echo ""
    print_status "🚀 Starting Balancer v3 Backend Local Development Environment"
    if [ "$DEV_MODE" = true ]; then
        print_status "🔧 Development Mode: Hot reloading enabled"
    fi
    echo ""

    # Setup compose arguments
    setup_compose_args

    # Check if Docker and Docker Compose are available
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed or not in PATH"
        exit 1
    fi

    if ! command -v docker compose &> /dev/null; then
        print_error "Docker Compose is not installed or not in PATH"
        exit 1
    fi

    # Check if .env file exists and warn if not
    if [ ! -f .env ]; then
        print_warning "No .env file found. Creating from template..."
        if [ -f env-template.txt ]; then
            cp env-template.txt .env
            print_status "Created .env from template. Please edit it with your API keys:"
            print_status "  THEGRAPH_API_KEY_FANTOM=your_key_here"
            print_status "  THEGRAPH_API_KEY_BALANCER=your_key_here"
        else
            print_warning "No template found. You may want to create .env manually."
        fi
        echo ""
    fi

    # Stop any existing containers
    print_status "Stopping any existing containers..."
    docker compose $COMPOSE_ARGS down || true

    # Start services in the correct order
    print_status "Starting infrastructure services..."
    docker compose $COMPOSE_ARGS up -d postgres redis localstack

    # Wait for LocalStack and run initialization
    wait_for_localstack

    # Start application services
    print_status "Starting application services..."
    docker compose $COMPOSE_ARGS up -d api worker scheduler

    # Wait for services to be healthy
    print_status "Checking service health..."
    check_service_health "balancer-postgres"
    check_service_health "balancer-api"
    
    # Worker and scheduler may not have health checks in dev mode
    if [ "$DEV_MODE" = false ]; then
        check_service_health "balancer-worker" || print_warning "Worker service health check failed, but it may still be working"
        check_service_health "balancer-scheduler" || print_warning "Scheduler service health check failed, but it may still be working"
    else
        print_status "Skipping health checks for worker/scheduler in dev mode"
    fi

    # Run database migrations
    run_migrations

    # Show final status
    print_success "🎉 All services are running!"
    show_status

    # Run validation
    print_status "🔍 Running startup validation..."
    if [ -f scripts/validate-startup.sh ]; then
        if ./scripts/validate-startup.sh; then
            print_success "✅ All validation tests passed!"
        else
            print_warning "⚠️  Some validation tests failed, but services are running"
            print_status "Run './scripts/start-local.sh validate' for detailed diagnostics"
        fi
    else
        print_warning "Validation script not found, skipping validation"
    fi

    # Option to follow logs
    print_status "Would you like to follow the logs? (y/N)"
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        print_status "Following logs... (Press Ctrl+C to stop)"
        docker compose $COMPOSE_ARGS logs -f
    fi
}

# Handle script arguments
case "${1:-}" in
    "dev")
        DEV_MODE=true
        setup_compose_args
        main
        ;;
    "stop")
        print_status "Stopping all services..."
        docker compose down
        print_success "All services stopped"
        ;;
    "clean")
        print_status "Stopping services and cleaning volumes..."
        docker compose down -v
        print_success "All services stopped and volumes cleaned"
        ;;
    "wipe"|"reset")
        print_warning "⚠️  This will completely wipe all Docker containers, volumes, networks, and images for this project!"
        print_status "Are you sure you want to continue? This action cannot be undone. (y/N)"
        read -r response
        if [[ "$response" =~ ^[Yy]$ ]]; then
            print_status "🧹 Performing complete cleanup..."
            
            # Stop and remove all containers
            print_status "Stopping and removing containers..."
            docker compose down --remove-orphans || true
            
            # Remove all volumes
            print_status "Removing all volumes..."
            docker compose down -v --remove-orphans || true
            
            # Remove named volumes specifically
            print_status "Removing named volumes..."
            docker volume rm balancer_postgres_data 2>/dev/null || true
            docker volume rm balancer_localstack_data 2>/dev/null || true
            
            # Remove networks
            print_status "Removing networks..."
            docker network rm balancer 2>/dev/null || true

            # Remove all project-related images
            print_status "Removing Docker images..."
            docker rmi balancer-v3-backend-api 2>/dev/null || true
            docker rmi balancer-v3-backend-worker 2>/dev/null || true
            docker rmi balancer-v3-backend-scheduler 2>/dev/null || true
            
            # Clean up any dangling images and build cache
            print_status "Cleaning up Docker build cache..."
            docker system prune -f --volumes || true
            
            print_success "🎉 Complete wipe finished! Everything has been reset to a clean state."
            print_status "💡 Run './scripts/start-local.sh' to start fresh"
        else
            print_status "Wipe cancelled."
        fi
        ;;
    "status")
        show_status
        ;;
    "validate")
        print_status "Running comprehensive startup validation..."
        if [ -f scripts/validate-startup.sh ]; then
            ./scripts/validate-startup.sh
        else
            print_error "Validation script not found at scripts/validate-startup.sh"
            exit 1
        fi
        ;;
    "logs")
        if [ -n "$2" ]; then
            docker compose logs -f "$2"
        else
            docker compose logs -f
        fi
        ;;
    "restart")
        print_status "Restarting services..."
        docker compose restart
        show_status
        ;;
    "build")
        print_status "Rebuilding all services..."
        docker compose build --no-cache
        print_success "All services rebuilt"
        ;;
    "help"|"-h"|"--help")
        echo "Balancer v3 Backend Local Development Script"
        echo ""
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  (no args)  Start all services in production mode"
        echo "  dev        Start all services in development mode (hot reload)"
        echo "  stop       Stop all services"
        echo "  clean      Stop services and remove volumes"
        echo "  wipe       Complete cleanup: containers, volumes, networks, images"
        echo "  reset      Alias for 'wipe'"
        echo "  status     Show service status"
        echo "  validate   Run comprehensive startup validation tests"
        echo "  logs       Follow logs (optionally specify service)"
        echo "  restart    Restart all services"
        echo "  build      Rebuild all services"
        echo "  help       Show this help"
        echo ""
        echo "Examples:"
        echo "  $0          # Start in production mode"
        echo "  $0 dev      # Start in development mode with hot reload"
        echo "  $0 logs api # Follow API service logs"
        echo "  $0 wipe     # Complete reset (removes everything)"
        echo ""
        ;;
    *)
        main
        ;;
esac 
