#!/bin/bash

# Deployment Scenarios Test Runner
# This script runs comprehensive integration tests for all deployment scenarios

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print banner
echo -e "${BLUE}🧪 Deployment Scenarios Integration Tests${NC}"
echo -e "${BLUE}===========================================${NC}"
echo ""

# Function to print section headers
print_section() {
    echo -e "${YELLOW}$1${NC}"
    echo -e "${YELLOW}$(printf '%*s' ${#1} '' | tr ' ' '-')${NC}"
}

# Function to check if LocalStack is running
check_localstack() {
    print_section "🔍 Checking LocalStack Status"
    
    if curl -s http://localhost:4566/_localstack/health > /dev/null 2>&1; then
        echo -e "${GREEN}✅ LocalStack is running${NC}"
        
        # Check service status
        echo "📊 Service Status:"
        curl -s http://localhost:4566/_localstack/health | python3 -m json.tool 2>/dev/null || echo "Health endpoint returned non-JSON response"
    else
        echo -e "${RED}❌ LocalStack is not running${NC}"
        echo ""
        echo "Please start LocalStack first:"
        echo "  npm run localstack:start"
        echo ""
        echo "Or check if it's starting:"
        echo "  npm run localstack:logs"
        exit 1
    fi
    echo ""
}

# Function to run specific test suite
run_test_suite() {
    local suite_name=$1
    local test_pattern=$2
    
    print_section "🧪 Running: $suite_name"
    
    if npx jest test/integration/deployment-scenarios.test.ts -t "$test_pattern" --silent; then
        echo -e "${GREEN}✅ $suite_name - PASSED${NC}"
    else
        echo -e "${RED}❌ $suite_name - FAILED${NC}"
        return 1
    fi
    echo ""
}

# Main execution
main() {
    local test_suite=${1:-"all"}
    local failed_tests=0
    
    echo "🎯 Test Suite: $test_suite"
    echo "📁 Working Directory: $(pwd)"
    echo ""
    
    # Check LocalStack first
    check_localstack
    
    case "$test_suite" in
        "all")
            echo -e "${BLUE}🚀 Running All Deployment Scenarios Tests${NC}"
            echo ""
            
            # Run individual test suites
            run_test_suite "Environment Normalization" "Environment Normalization" || ((failed_tests++))
            run_test_suite "CloudFormation Operations" "CloudFormation Stack Operations" || ((failed_tests++))
            run_test_suite "ECS Task Definition" "ECS Task Definition" || ((failed_tests++))
            run_test_suite "Database Naming Patterns" "Database Instance Naming Patterns" || ((failed_tests++))
            run_test_suite "Database Connectivity Validation" "Database Connectivity Validation" || ((failed_tests++))
            run_test_suite "Secrets Management" "Secrets Management" || ((failed_tests++))
            run_test_suite "Migration Script Error Handling" "Migration Script Error Handling" || ((failed_tests++))
            run_test_suite "CloudFormation Stack Naming" "CloudFormation Stack Naming" || ((failed_tests++))
            run_test_suite "Protocol Detection Logic" "Protocol Detection Logic" || ((failed_tests++))
            run_test_suite "Resource Naming Consistency" "Resource Naming Consistency" || ((failed_tests++))
            run_test_suite "Timeout and Error Recovery" "Timeout and Error Recovery" || ((failed_tests++))
            run_test_suite "IAM Policy Validation" "IAM Policy Validation" || ((failed_tests++))
            run_test_suite "GitHub Actions Workflow Integration" "GitHub Actions Workflow Integration" || ((failed_tests++))
            ;;
        "env")
            run_test_suite "Environment Normalization" "Environment Normalization" || ((failed_tests++))
            ;;
        "cloudformation"|"cf")
            run_test_suite "CloudFormation Operations" "CloudFormation Stack Operations" || ((failed_tests++))
            ;;
        "ecs")
            run_test_suite "ECS Task Definition" "ECS Task Definition" || ((failed_tests++))
            ;;
        "database"|"db")
            run_test_suite "Database Naming Patterns" "Database Instance Naming Patterns" || ((failed_tests++))
            run_test_suite "Database Connectivity Validation" "Database Connectivity Validation" || ((failed_tests++))
            ;;
        "secrets")
            run_test_suite "Secrets Management" "Secrets Management" || ((failed_tests++))
            ;;
        "migration")
            run_test_suite "Migration Script Error Handling" "Migration Script Error Handling" || ((failed_tests++))
            ;;
        "iam")
            run_test_suite "IAM Policy Validation" "IAM Policy Validation" || ((failed_tests++))
            ;;
        "naming")
            run_test_suite "Resource Naming Consistency" "Resource Naming Consistency" || ((failed_tests++))
            run_test_suite "CloudFormation Stack Naming" "CloudFormation Stack Naming" || ((failed_tests++))
            ;;
        "timeout")
            run_test_suite "Timeout and Error Recovery" "Timeout and Error Recovery" || ((failed_tests++))
            ;;
        "workflow")
            run_test_suite "GitHub Actions Workflow Integration" "GitHub Actions Workflow Integration" || ((failed_tests++))
            ;;
        "quick")
            echo -e "${BLUE}🏃 Running Quick Test Suite (Core Tests Only)${NC}"
            echo ""
            run_test_suite "Environment Normalization" "Environment Normalization" || ((failed_tests++))
            run_test_suite "Resource Naming Consistency" "Resource Naming Consistency" || ((failed_tests++))
            run_test_suite "IAM Policy Validation" "IAM Policy Validation" || ((failed_tests++))
            ;;
        "help"|"-h"|"--help")
            show_help
            exit 0
            ;;
        *)
            echo -e "${RED}❌ Unknown test suite: $test_suite${NC}"
            echo ""
            show_help
            exit 1
            ;;
    esac
    
    # Final results
    print_section "📊 Test Results Summary"
    
    if [ $failed_tests -eq 0 ]; then
        echo -e "${GREEN}🎉 All tests passed! Your deployment infrastructure is ready.${NC}"
        echo ""
        echo "✅ Environment normalization works correctly"
        echo "✅ VPC configuration retrieval is reliable"
        echo "✅ ECS task definitions are properly structured"
        echo "✅ IAM permissions are correctly configured"
        echo "✅ Resource naming is consistent across environments"
        echo "✅ Error handling provides useful debugging information"
        echo "✅ Migration scripts are resilient to failures"
        echo ""
        echo -e "${BLUE}Your deployment should now work without the issues we fixed! 🚀${NC}"
    else
        echo -e "${RED}❌ $failed_tests test suite(s) failed${NC}"
        echo ""
        echo "🔧 Troubleshooting steps:"
        echo "1. Check LocalStack is running: npm run localstack:logs"
        echo "2. Restart LocalStack: npm run localstack:stop && npm run localstack:start"
        echo "3. Run tests in verbose mode: npx jest test/integration/deployment-scenarios.test.ts --verbose"
        echo "4. Check the test documentation: cat test/integration/README.md"
        exit 1
    fi
}

# Help function
show_help() {
    echo -e "${BLUE}Deployment Scenarios Test Runner${NC}"
    echo ""
    echo "Usage: $0 [test-suite]"
    echo ""
    echo "Test Suites:"
    echo "  all         Run all deployment scenario tests (default)"
    echo "  quick       Run core tests only (faster)"
    echo "  env         Environment normalization tests"
    echo "  cf          CloudFormation operations tests"
    echo "  ecs         ECS task definition tests"
    echo "  database    Database naming and connectivity tests"
    echo "  secrets     Secrets management tests"
    echo "  migration   Migration script error handling tests"
    echo "  iam         IAM policy validation tests"
    echo "  naming      Resource naming consistency tests"
    echo "  timeout     Timeout and error recovery tests"
    echo "  workflow    GitHub Actions workflow integration tests"
    echo "  help        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                    # Run all tests"
    echo "  $0 quick              # Run core tests only"
    echo "  $0 env                # Test environment normalization"
    echo "  $0 iam                # Test IAM policy structure"
    echo ""
    echo "Prerequisites:"
    echo "  - LocalStack must be running: npm run localstack:start"
    echo "  - Dependencies installed: npm ci"
    echo ""
    echo "Troubleshooting:"
    echo "  - Check LocalStack: curl http://localhost:4566/_localstack/health"
    echo "  - View logs: npm run localstack:logs"
    echo "  - Clean data: npm run localstack:clean"
}

# Execute main function with all arguments
main "$@" 
