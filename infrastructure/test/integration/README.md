# 🧪 Deployment Scenarios Integration Tests

This test suite validates all the critical deployment scenarios and fixes that were implemented during the deployment troubleshooting process. These tests ensure that our deployment infrastructure is robust and handles edge cases properly.

## 🎯 Test Coverage

### 1. **Environment Normalization Tests**

Validates the environment name normalization logic that fixes the "dev" → "development" mismatch:

-   ✅ `dev` → `development`
-   ✅ `staging` → `staging`
-   ✅ `prod` → `production`
-   ✅ Unknown environments default to `development`

**Why this matters**: The GitHub Actions workflow passes `ENVIRONMENT=dev` but CDK creates stacks with "development" names. This normalization prevents deployment failures.

### 2. **CloudFormation Stack Operations**

Tests CloudFormation stack creation and output retrieval:

-   ✅ Creates networking stack with proper outputs
-   ✅ Retrieves `PrivateSubnetIds` correctly
-   ✅ Retrieves ECS security group ID from complex output keys
-   ✅ Validates CloudFormation stack naming patterns

**Why this matters**: The migration script must retrieve VPC configuration from CloudFormation outputs to run ECS tasks.

### 3. **ECS Task Definition & Execution**

Validates ECS cluster and task definition creation:

-   ✅ Creates ECS cluster with correct naming
-   ✅ Registers migration task definitions
-   ✅ Handles LocalStack ECS limitations gracefully

**Why this matters**: Database migrations run as ECS tasks and must be properly configured.

### 4. **Database Instance Naming**

Validates RDS instance naming conventions:

-   ✅ `v3-backend-{environment}-database` pattern
-   ✅ Consistent naming across environments

**Why this matters**: Production database backup scripts must find the correct RDS instance.

### 5. **Secrets Management**

Tests environment-specific secrets creation:

-   ✅ Creates secrets with proper naming: `v3-backend/{environment}/config`
-   ✅ Validates secret content structure

**Why this matters**: Applications need environment-specific configuration secrets.

### 6. **Migration Script Error Handling**

Tests migration script resilience:

-   ✅ Handles VPC configuration failures gracefully
-   ✅ Provides debugging information on failures
-   ✅ Validates environment normalization in script context

**Why this matters**: Migration scripts must fail gracefully and provide useful debugging information.

### 7. **Protocol Detection Logic**

Tests ALB listener protocol detection:

-   ✅ Detects HTTPS listeners (port 443)
-   ✅ Falls back to HTTP when HTTPS not available
-   ✅ Handles mixed HTTP/HTTPS configurations

**Why this matters**: Health checks and integration tests must use the correct protocol.

### 8. **Resource Naming Consistency**

Validates consistent naming across all AWS resources:

-   ✅ Cluster names: `v3-backend-{environment}-cluster`
-   ✅ Task definitions: `v3-backend-{environment}-migration-task`
-   ✅ Log groups: `/v3-backend/{environment}/migration`
-   ✅ Secrets: `v3-backend/{environment}/config`
-   ✅ Stacks: `v3-backend-{environment}-{type}`

**Why this matters**: Consistent naming enables reliable resource discovery and management.

### 9. **Timeout & Error Recovery**

Tests timeout handling and error recovery:

-   ✅ Migration task timeouts are handled properly
-   ✅ Debugging information is provided on failures
-   ✅ Timeout commands work correctly

**Why this matters**: Deployment pipelines must not hang indefinitely and should provide useful error information.

### 10. **IAM Policy Validation**

Validates IAM permissions structure:

-   ✅ PassRole permissions are correctly structured
-   ✅ ECS task execution conditions are proper
-   ✅ All critical deployment permissions are covered

**Why this matters**: GitHub Actions role must have all necessary permissions to deploy infrastructure and run migrations.

### 11. **GitHub Actions Workflow Integration**

Tests workflow configuration mapping:

-   ✅ Environment-to-resource name mapping is correct
-   ✅ "dev" environment uses "development" resource names
-   ✅ All environments follow consistent patterns

**Why this matters**: The GitHub Actions workflow must reference the correct AWS resources for each environment.

## 🚀 Running the Tests

### Prerequisites

1. **LocalStack must be running**:

    ```bash
    npm run localstack:start
    ```

2. **Install dependencies**:
    ```bash
    npm ci
    ```

### Run All Integration Tests

```bash
npm run test:integration
```

### Run Only Deployment Scenarios

```bash
npx jest test/integration/deployment-scenarios.test.ts
```

### Run Specific Test Suites

```bash
# Environment normalization only
npx jest test/integration/deployment-scenarios.test.ts -t "Environment Normalization"

# CloudFormation operations only
npx jest test/integration/deployment-scenarios.test.ts -t "CloudFormation Stack Operations"

# IAM policy validation only
npx jest test/integration/deployment-scenarios.test.ts -t "IAM Policy Validation"
```

### Debug Mode

```bash
DEBUG=* npx jest test/integration/deployment-scenarios.test.ts --verbose
```

## 🔧 Test Configuration

### LocalStack Services Used

-   **CloudFormation**: Stack operations and output retrieval
-   **ECS**: Cluster and task definition creation
-   **Secrets Manager**: Environment-specific secrets
-   **RDS**: Database instance validation (naming only)

### Test Environment Variables

```bash
AWS_ENDPOINT_URL=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_REGION=us-east-1
```

## 🐛 Troubleshooting

### Common Issues

#### 1. **LocalStack Not Running**

```
Error: connect ECONNREFUSED 127.0.0.1:4566
```

**Solution**: Start LocalStack first:

```bash
npm run localstack:start
```

#### 2. **ECS Limitations in LocalStack**

Some tests may show warnings about ECS limitations. This is expected and the tests handle it gracefully.

#### 3. **Test Timeouts**

If tests timeout, increase the Jest timeout:

```bash
npx jest --testTimeout=60000 test/integration/deployment-scenarios.test.ts
```

#### 4. **LocalStack Service Not Ready**

```
Error: LocalStack not ready after 90000ms
```

**Solution**: Wait longer or restart LocalStack:

```bash
npm run localstack:stop
npm run localstack:start
```

### Debug Commands

#### Check LocalStack Health

```bash
curl http://localhost:4566/_localstack/health
```

#### View LocalStack Logs

```bash
npm run localstack:logs
```

#### Clean LocalStack Data

```bash
npm run localstack:clean
npm run localstack:start
```

## 🔄 Continuous Integration

These tests run automatically in CI/CD pipelines to ensure deployment reliability:

1. **Pre-deployment validation**: Tests run before each deployment
2. **Environment consistency**: Validates that all environments follow the same patterns
3. **Migration safety**: Ensures migration scripts handle errors gracefully
4. **Infrastructure validation**: Confirms CloudFormation stacks are properly configured

## 📚 Related Documentation

-   [Migration Script Documentation](../scripts/run-migration.sh)
-   [GitHub Actions Workflow](.github/workflows/deploy.yml)
-   [IAM Policy Documentation](infrastructure/docs/github-actions-iam-policy.json)
-   [Deployment Setup Guide](DEPLOYMENT_SETUP.md)

## 🎉 Success Metrics

All tests should pass, indicating:

-   ✅ Environment normalization works correctly
-   ✅ VPC configuration retrieval is reliable
-   ✅ ECS task definitions are properly structured
-   ✅ IAM permissions are correctly configured
-   ✅ Resource naming is consistent across environments
-   ✅ Error handling provides useful debugging information
-   ✅ Migration scripts are resilient to failures

When all tests pass, you can be confident that the deployment infrastructure will handle the scenarios that previously caused deployment failures.
