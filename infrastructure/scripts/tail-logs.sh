#!/bin/bash

# Live tail CloudWatch logs for all services in an environment
# Usage examples:
#   ./tail-logs.sh                          # Show recent logs from development
#   ./tail-logs.sh dev                      # Show recent logs from development  
#   ./tail-logs.sh dev --follow             # Live tail development logs
#   ./tail-logs.sh staging --follow         # Live tail staging logs
#   ./tail-logs.sh prod --services api      # Show only API logs from production
#   ./tail-logs.sh dev --filter "ERROR"     # Show only logs containing "ERROR"

set -e

# Default values
ENVIRONMENT="development"
FOLLOW=""
SERVICES=""
FILTER=""
LINES="20"
EXTRA_ARGS=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to show usage
show_usage() {
    echo -e "${BLUE}Live tail CloudWatch logs for all services in an environment${NC}"
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
    echo "  -f, --follow              - Live tail logs (continuous)"
    echo "  -s, --services <list>     - Comma-separated services (api,background,waf,vpc)"
    echo "  --filter <pattern>        - CloudWatch filter pattern"
    echo "  -n, --lines <number>      - Number of lines/minutes of history (default: 20)"
    echo "  --start-time <time>       - Start time (ISO string or '2h ago')"
    echo "  -q, --quiet               - Suppress discovery messages"
    echo "  --json                    - Output in JSON format"
    echo "  --no-colors               - Disable colored output"
    echo "  -h, --help                - Show this help"
    echo ""
    echo -e "${YELLOW}Examples:${NC}"
    echo "  $0                                    # Recent logs from development"
    echo "  $0 dev --follow                      # Live tail development logs"
    echo "  $0 staging --follow --services api   # Live tail staging API logs only"
    echo "  $0 prod --filter 'ERROR'             # Show production error logs"
    echo "  $0 dev --start-time '1h ago'         # Show last hour of dev logs"
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
        -f|--follow)
            FOLLOW="--follow"
            shift
            ;;
        -s|--services)
            SERVICES="--services $2"
            shift 2
            ;;
        --filter)
            FILTER="--filter $2"
            shift 2
            ;;
        -n|--lines)
            LINES="$2"
            shift 2
            ;;
        --start-time)
            EXTRA_ARGS="$EXTRA_ARGS --start-time '$2'"
            shift 2
            ;;
        -q|--quiet)
            EXTRA_ARGS="$EXTRA_ARGS --quiet"
            shift
            ;;
        --json)
            EXTRA_ARGS="$EXTRA_ARGS --json"
            shift
            ;;
        --no-colors)
            EXTRA_ARGS="$EXTRA_ARGS --no-colors"
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

# Build the command (will be updated to use npx later)
CMD_BASE="scripts/live-tail-logs.ts --env $ENVIRONMENT --lines $LINES $FOLLOW $SERVICES $FILTER $EXTRA_ARGS"

echo -e "${BLUE}🚀 Starting log tailer for environment: ${GREEN}$ENVIRONMENT${NC}"
if [[ -n "$FOLLOW" ]]; then
    echo -e "${YELLOW}📡 Live tailing mode - Press Ctrl+C to stop${NC}"
fi
echo ""

# Check if dependencies are installed
if [[ ! -d "node_modules" ]]; then
    echo -e "${YELLOW}⚠️  Installing dependencies...${NC}"
    npm install
    echo ""
fi

# Check if ts-node is available
if ! command -v npx &> /dev/null; then
    echo -e "${RED}Error: npx is not available. Please install Node.js and npm.${NC}" >&2
    exit 1
fi

# Execute the command using npx to ensure ts-node is available
CMD="npx ts-node $CMD_BASE"
eval $CMD 
