#!/bin/bash

# Cancel a stuck CloudFormation stack deployment
# Usage examples:
#   ./cancel-stuck-deployment.sh                    # Cancel development compute stack
#   ./cancel-stuck-deployment.sh dev                # Cancel development compute stack
#   ./cancel-stuck-deployment.sh staging            # Cancel staging compute stack
#   ./cancel-stuck-deployment.sh --monitor          # Cancel and monitor progress

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="development"
MONITOR=""
FORCE=""
QUIET=""
STACK_NAME=""

# Function to show usage
show_usage() {
    echo -e "${BLUE}Cancel a stuck CloudFormation stack update operation${NC}"
    echo ""
    echo -e "${YELLOW}Usage:${NC}"
    echo "  $0 [environment] [options]"
    echo ""
    echo -e "${YELLOW}Environments:${NC}"
    echo "  dev, development    - Development environment (default)"
    echo "  staging            - Staging environment"
    echo "  prod, production   - Production environment"
    echo ""
    echo -e "${YELLOW}Options:${NC}"
    echo "  -s, --stack-name <name>  - Exact stack name (overrides environment)"
    echo "  -m, --monitor            - Monitor cancellation progress"
    echo "  -f, --force              - Force cancellation even if not in UPDATE_IN_PROGRESS"
    echo "  -q, --quiet              - Suppress non-essential output"
    echo "  -h, --help               - Show this help"
    echo ""
    echo -e "${YELLOW}Examples:${NC}"
    echo "  $0                           # Cancel development compute stack"
    echo "  $0 dev --monitor             # Cancel dev stack and monitor progress"
    echo "  $0 staging                   # Cancel staging compute stack"
    echo "  $0 --stack-name my-stack     # Cancel specific stack by name"
    echo ""
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        dev|development)
            ENVIRONMENT="development"
            shift
            ;;
        staging)
            ENVIRONMENT="staging"
            shift
            ;;
        prod|production)
            ENVIRONMENT="production"
            shift
            ;;
        -s|--stack-name)
            STACK_NAME="--stack-name $2"
            shift 2
            ;;
        -m|--monitor)
            MONITOR="--monitor"
            shift
            ;;
        -f|--force)
            FORCE="--force"
            shift
            ;;
        -q|--quiet)
            QUIET="--quiet"
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            echo -e "${RED}Error: Unknown argument '$1'${NC}" >&2
            echo "Use --help for usage information."
            exit 1
            ;;
    esac
done

# Check if we're in the infrastructure directory
if [[ ! -f "package.json" ]] || [[ ! -d "scripts" ]]; then
    echo -e "${RED}Error: This script must be run from the infrastructure directory${NC}" >&2
    exit 1
fi

# Check if dependencies are installed
if [[ ! -d "node_modules" ]]; then
    echo -e "${YELLOW}⚠️  Installing dependencies...${NC}"
    npm install
    echo ""
fi

# Build the command
if [[ -n "$STACK_NAME" ]]; then
    CMD="npx ts-node scripts/cancel-stack-update.ts $STACK_NAME $MONITOR $FORCE $QUIET"
    echo -e "${BLUE}🛑 Cancelling specific stack...${NC}"
else
    CMD="npx ts-node scripts/cancel-stack-update.ts --environment $ENVIRONMENT $MONITOR $FORCE $QUIET"
    echo -e "${BLUE}🛑 Cancelling compute stack for environment: ${GREEN}$ENVIRONMENT${NC}"
fi

# Execute the command
eval $CMD

# Show next steps if not quiet
if [[ -z "$QUIET" ]]; then
    echo ""
    echo -e "${YELLOW}💡 Next steps:${NC}"
    echo "  • Check AWS Console CloudFormation for detailed progress"
    echo "  • Wait for rollback to complete before attempting new deployment"
    echo "  • If issues persist, check ECS service health and logs"
    echo "  • Consider using the log tailer: ./scripts/tail-logs.sh dev --follow"
fi 
