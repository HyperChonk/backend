#!/bin/bash

# Balancer v3 Backend - Local Development Helper Script

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_help() {
    echo -e "${BLUE}Balancer v3 Backend - Local Development Helper${NC}"
    echo
    echo "Usage: ./docker-dev.sh [command]"
    echo
    echo "Commands:"
    echo "  setup     - Initial setup (copy env, build images)"
    echo "  start     - Start all services"
    echo "  api       - Start only API service + database"
    echo "  worker    - Start only worker service + database"  
    echo "  scheduler - Start only scheduler service + database"
    echo "  stop      - Stop all services"
    echo "  restart   - Restart all services"
    echo "  logs      - Show logs for all services"
    echo "  logs-api  - Show logs for API service only"
    echo "  shell     - Open shell in API container"
    echo "  db        - Connect to PostgreSQL database"
    echo "  migrate   - Run database migrations"
    echo "  build     - Rebuild Docker images"
    echo "  clean     - Stop and remove all containers and volumes"
    echo "  status    - Show status of all services"
    echo
}

check_docker() {
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Docker is not installed or not running${NC}"
        exit 1
    fi
    
    # Check for modern docker compose (space) or legacy docker compose (hyphen)
    if docker compose version &> /dev/null; then
        DOCKER_COMPOSE="docker compose"
    elif command -v docker compose &> /dev/null; then
        DOCKER_COMPOSE="docker compose"
    else
        echo -e "${RED}Docker Compose is not installed${NC}"
        echo -e "${YELLOW}Install with: apt-get install docker compose-plugin${NC}"
        exit 1
    fi
}

setup() {
    echo -e "${BLUE}Setting up local development environment...${NC}"
    
    # Copy environment file if it doesn't exist
    if [ ! -f .env ]; then
        echo -e "${YELLOW}Creating .env file from .env.docker template...${NC}"
        cp .env.docker .env
        echo -e "${YELLOW}⚠️  Please edit .env file and add your API keys!${NC}"
    fi
    
    # Build images
    echo -e "${GREEN}Building Docker images...${NC}"
    $DOCKER_COMPOSE build
    
    echo -e "${GREEN}✅ Setup complete!${NC}"
    echo -e "${YELLOW}Next steps:${NC}"
    echo "1. Edit .env file with your API keys"
    echo "2. Run: ./docker-dev.sh start"
    echo "3. Run migrations: ./docker-dev.sh migrate"
}

start_all() {
    echo -e "${GREEN}Starting all services...${NC}"
    $DOCKER_COMPOSE up -d
    show_status
}

start_api_only() {
    echo -e "${GREEN}Starting API service and database...${NC}"
    $DOCKER_COMPOSE up -d postgres redis api
    show_status
}

start_worker_only() {
    echo -e "${GREEN}Starting worker service and database...${NC}"
    $DOCKER_COMPOSE up -d postgres redis worker
    show_status
}

start_scheduler_only() {
    echo -e "${GREEN}Starting scheduler service and database...${NC}"
    $DOCKER_COMPOSE up -d postgres redis scheduler
    show_status
}

stop_all() {
    echo -e "${YELLOW}Stopping all services...${NC}"
    $DOCKER_COMPOSE down
}

restart_all() {
    echo -e "${YELLOW}Restarting all services...${NC}"
    $DOCKER_COMPOSE restart
    show_status
}

show_logs() {
    $DOCKER_COMPOSE logs -f
}

show_api_logs() {
    $DOCKER_COMPOSE logs -f api
}

shell_access() {
    echo -e "${GREEN}Opening shell in API container...${NC}"
    $DOCKER_COMPOSE exec api bash
}

db_access() {
    echo -e "${GREEN}Connecting to PostgreSQL database...${NC}"
    $DOCKER_COMPOSE exec postgres psql -U backend -d database
}

migrate() {
    echo -e "${GREEN}Running database migrations...${NC}"
    $DOCKER_COMPOSE exec api bunx prisma migrate deploy
    echo -e "${GREEN}✅ Migrations complete${NC}"
}

build_images() {
    echo -e "${GREEN}Rebuilding Docker images...${NC}"
    $DOCKER_COMPOSE build --no-cache
}

clean_all() {
    echo -e "${RED}Cleaning up all containers and volumes...${NC}"
    read -p "This will delete all data. Are you sure? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        $DOCKER_COMPOSE down -v --remove-orphans
        docker system prune -f
        echo -e "${GREEN}✅ Cleanup complete${NC}"
    else
        echo -e "${YELLOW}Cleanup cancelled${NC}"
    fi
}

show_status() {
    echo -e "${BLUE}Service Status:${NC}"
    $DOCKER_COMPOSE ps
    echo
    echo -e "${BLUE}API Health Check:${NC}"
    if curl -s http://localhost:4000/health >/dev/null 2>&1; then
        echo -e "${GREEN}✅ API is healthy: http://localhost:4000${NC}"
    else
        echo -e "${RED}❌ API is not responding${NC}"
    fi
}

# Main script logic
check_docker

case "${1:-help}" in
    setup)
        setup
        ;;
    start)
        start_all
        ;;
    api)
        start_api_only
        ;;
    worker)
        start_worker_only
        ;;
    scheduler)
        start_scheduler_only
        ;;
    stop)
        stop_all
        ;;
    restart)
        restart_all
        ;;
    logs)
        show_logs
        ;;
    logs-api)
        show_api_logs
        ;;
    shell)
        shell_access
        ;;
    db)
        db_access
        ;;
    migrate)
        migrate
        ;;
    build)
        build_images
        ;;
    clean)
        clean_all
        ;;
    status)
        show_status
        ;;
    help|--help|-h)
        print_help
        ;;
    *)
        echo -e "${RED}Unknown command: $1${NC}"
        echo
        print_help
        exit 1
        ;;
esac
