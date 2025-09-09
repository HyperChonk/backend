#!/bin/bash

# CLI script to commit, push, and trigger GitHub Actions workflows
# Usage: ./scripts/deploy-cli.sh [OPTIONS]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
COMMIT_MESSAGE=""
SKIP_COMMIT=false
SKIP_PUSH=false
WORKFLOW=""
ENVIRONMENT=""
IMAGE_TAG=""
FORCE_REBUILD=false
CONFIRM_PRODUCTION=""
AUTO_DEPLOY=false

# Function to print colored output
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Function to show usage
show_usage() {
    cat << EOF
🚀 Deploy CLI - Commit, Push, and Trigger GitHub Actions

Usage: ./scripts/deploy-cli.sh [OPTIONS]

Options:
  -m, --message MESSAGE      Commit message (required unless --skip-commit)
  -w, --workflow WORKFLOW    Workflow to trigger: build, deploy-code, deploy-infra
  -e, --environment ENV      Environment for deployment: dev, staging, production
  -t, --image-tag TAG        Docker image tag for deployment
  -f, --force-rebuild        Force rebuild even if image exists (build workflow only)
  -c, --confirm-production   Confirm production deployment (auto-adds confirmation)
  -a, --auto-deploy          Mark as auto-deploy (deploy-code workflow only)
  --skip-commit              Skip git commit (just push and trigger workflow)
  --skip-push                Skip git push (just commit and trigger workflow)
  -h, --help                 Show this help message

Examples:
  # Build workflow
  ./scripts/deploy-cli.sh -m "Add new feature" -w build -f

  # Deploy code workflow
  ./scripts/deploy-cli.sh -m "Deploy to staging" -w deploy-code -e staging -t 1.41.8-abc123

  # Deploy infrastructure workflow
  ./scripts/deploy-cli.sh -m "Update infra" -w deploy-infra -e production -t 1.41.8-abc123 -c

  # Just trigger workflow without committing
  ./scripts/deploy-cli.sh --skip-commit -w build -f

  # Commit and push without triggering workflow
  ./scripts/deploy-cli.sh -m "Update code" --skip-workflow

EOF
}

# Function to check if gh CLI is installed
check_gh_cli() {
    if ! command -v gh &> /dev/null; then
        print_error "GitHub CLI (gh) is not installed. Please install it first:"
        print_info "https://cli.github.com/"
        exit 1
    fi
}

# Function to get current git branch
get_current_branch() {
    git branch --show-current
}

# Function to get latest commit hash
get_latest_commit_hash() {
    git rev-parse --short HEAD
}

# Function to get latest image tag from ECR
get_latest_image_tag() {
    print_info "Fetching latest image tag from ECR..."
    
    # Check if AWS CLI is available
    if ! command -v aws &> /dev/null; then
        print_error "AWS CLI is not installed. Cannot fetch latest image tag."
        return 1
    fi
    
    # Get the latest image tag from ECR
    latest_tag=$(aws ecr describe-images \
        --repository-name balancer-api \
        --region us-east-1 \
        --query 'sort_by(imageDetails,&imagePushedAt)[-1].imageTags[0]' \
        --output text 2>/dev/null || echo "")
    
    if [ -n "$latest_tag" ] && [ "$latest_tag" != "None" ]; then
        echo "$latest_tag"
    else
        print_warning "Could not fetch latest image tag from ECR"
        echo ""
    fi
}

# Function to commit changes
commit_changes() {
    if [ "$SKIP_COMMIT" = true ]; then
        print_info "Skipping git commit"
        return 0
    fi
    
    if [ -z "$COMMIT_MESSAGE" ]; then
        print_error "Commit message is required unless --skip-commit is used"
        exit 1
    fi
    
    # Check if there are any changes to commit
    if git diff --quiet && git diff --cached --quiet; then
        print_warning "No changes to commit"
        return 0
    fi
    
    print_info "Committing changes..."
    
    # Add all changes
    git add .
    
    # Create commit with the provided message
    git commit -m "$COMMIT_MESSAGE

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
    
    print_success "Changes committed successfully"
}

# Function to push changes
push_changes() {
    if [ "$SKIP_PUSH" = true ]; then
        print_info "Skipping git push"
        return 0
    fi
    
    local current_branch=$(get_current_branch)
    
    print_info "Pushing changes to origin/$current_branch..."
    
    # Push changes to remote
    git push origin "$current_branch"
    
    print_success "Changes pushed successfully"
}

# Function to trigger build workflow
trigger_build_workflow() {
    print_info "Triggering Build Docker Image workflow..."
    
    local inputs=""
    if [ "$FORCE_REBUILD" = true ]; then
        inputs="--field force_rebuild=true"
    fi
    
    gh workflow run build.yml $inputs
    
    print_success "Build workflow triggered successfully"
    print_info "View workflow: https://github.com/$(gh repo view --json owner,name -q '.owner.login + "/" + .name')/actions/workflows/build.yml"
}

# Function to trigger deploy-code workflow
trigger_deploy_code_workflow() {
    if [ -z "$ENVIRONMENT" ]; then
        print_error "Environment is required for deploy-code workflow"
        exit 1
    fi
    
    if [ -z "$IMAGE_TAG" ]; then
        print_warning "No image tag provided. Attempting to fetch latest..."
        IMAGE_TAG=$(get_latest_image_tag)
        if [ -z "$IMAGE_TAG" ]; then
            print_error "Image tag is required for deploy-code workflow"
            exit 1
        fi
        print_info "Using latest image tag: $IMAGE_TAG"
    fi
    
    print_info "Triggering Deploy Code Only workflow..."
    print_info "Environment: $ENVIRONMENT"
    print_info "Image Tag: $IMAGE_TAG"
    
    local inputs="--field environment=$ENVIRONMENT --field image_tag=$IMAGE_TAG"
    
    if [ "$AUTO_DEPLOY" = true ]; then
        inputs="$inputs --field auto_deploy=true"
    fi
    
    if [ "$ENVIRONMENT" = "production" ]; then
        if [ -z "$CONFIRM_PRODUCTION" ]; then
            CONFIRM_PRODUCTION="DEPLOY TO PRODUCTION"
        fi
        inputs="$inputs --field confirm_production=$CONFIRM_PRODUCTION"
    fi
    
    gh workflow run deploy-code.yml $inputs
    
    print_success "Deploy Code workflow triggered successfully"
    print_info "View workflow: https://github.com/$(gh repo view --json owner,name -q '.owner.login + "/" + .name')/actions/workflows/deploy-code.yml"
}

# Function to trigger deploy-infra workflow
trigger_deploy_infra_workflow() {
    if [ -z "$ENVIRONMENT" ]; then
        print_error "Environment is required for deploy-infra workflow"
        exit 1
    fi
    
    if [ -z "$IMAGE_TAG" ]; then
        print_warning "No image tag provided. Attempting to fetch latest..."
        IMAGE_TAG=$(get_latest_image_tag)
        if [ -z "$IMAGE_TAG" ]; then
            print_error "Image tag is required for deploy-infra workflow"
            exit 1
        fi
        print_info "Using latest image tag: $IMAGE_TAG"
    fi
    
    print_info "Triggering Deploy Infrastructure workflow..."
    print_info "Environment: $ENVIRONMENT"
    print_info "Image Tag: $IMAGE_TAG"
    
    local inputs="--field environment=$ENVIRONMENT --field image_tag=$IMAGE_TAG"
    
    if [ "$ENVIRONMENT" = "production" ]; then
        if [ -z "$CONFIRM_PRODUCTION" ]; then
            CONFIRM_PRODUCTION="DEPLOY TO PRODUCTION"
        fi
        inputs="$inputs --field confirm_production=$CONFIRM_PRODUCTION"
    fi
    
    gh workflow run deploy-infra.yml $inputs
    
    print_success "Deploy Infrastructure workflow triggered successfully"
    print_info "View workflow: https://github.com/$(gh repo view --json owner,name -q '.owner.login + "/" + .name')/actions/workflows/deploy-infra.yml"
}

# Function to trigger workflow
trigger_workflow() {
    if [ -z "$WORKFLOW" ]; then
        print_info "No workflow specified. Skipping workflow trigger."
        return 0
    fi
    
    check_gh_cli
    
    case "$WORKFLOW" in
        "build")
            trigger_build_workflow
            ;;
        "deploy-code")
            trigger_deploy_code_workflow
            ;;
        "deploy-infra")
            trigger_deploy_infra_workflow
            ;;
        *)
            print_error "Unknown workflow: $WORKFLOW"
            print_info "Available workflows: build, deploy-code, deploy-infra"
            exit 1
            ;;
    esac
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -m|--message)
            COMMIT_MESSAGE="$2"
            shift 2
            ;;
        -w|--workflow)
            WORKFLOW="$2"
            shift 2
            ;;
        -e|--environment)
            ENVIRONMENT="$2"
            shift 2
            ;;
        -t|--image-tag)
            IMAGE_TAG="$2"
            shift 2
            ;;
        -f|--force-rebuild)
            FORCE_REBUILD=true
            shift
            ;;
        -c|--confirm-production)
            CONFIRM_PRODUCTION="DEPLOY TO PRODUCTION"
            shift
            ;;
        -a|--auto-deploy)
            AUTO_DEPLOY=true
            shift
            ;;
        --skip-commit)
            SKIP_COMMIT=true
            shift
            ;;
        --skip-push)
            SKIP_PUSH=true
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Main execution
main() {
    print_info "🚀 Deploy CLI - Starting workflow..."
    
    # Show current status
    local current_branch=$(get_current_branch)
    local current_commit=$(get_latest_commit_hash)
    
    print_info "Current branch: $current_branch"
    print_info "Current commit: $current_commit"
    
    # Execute steps
    commit_changes
    push_changes
    trigger_workflow
    
    print_success "🎉 Deploy CLI workflow completed successfully!"
    
    if [ -n "$WORKFLOW" ]; then
        print_info "You can monitor the workflow progress at:"
        print_info "https://github.com/$(gh repo view --json owner,name -q '.owner.login + "/" + .name')/actions"
    fi
}

# Run main function
main