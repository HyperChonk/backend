# Deploy Code Workflow Analysis

## Current State Analysis

### What's Currently Happening

**UPDATE**: Based on additional data provided, the deployment was actually **SUCCESSFUL**. The new analysis shows:

1. **Deployment Execution**: The script successfully:

    - Updates the SSM parameter with the new image tag
    - Triggers deployment for all three services (api, worker, scheduler)
    - Forces new deployments without creating new task definitions (since no secrets are provided)

2. **Service Status**: All services are running and healthy:

    - `v3-backend-staging-scheduler-service`: 1/1 tasks running ✅
    - `v3-backend-staging-api-service`: 2/2 tasks running ✅
    - `v3-backend-staging-worker-service`: 2/2 tasks running ✅
    - Load balancer: 2/2 targets healthy ✅
    - HTTP/HTTPS endpoints: 200 OK ✅

3. **Health Check Confirmation**: The health endpoint shows:

    ```json
    {
        "status": "healthy",
        "build": {
            "version": "staging-46f6fc8113d7e16f3f7a73369f8ada0c5383ccce",
            "gitCommit": {
                "hash": "46f6fc8113d7e16f3f7a73369f8ada0c5383ccce",
                "shortHash": "46f6fc8"
            }
        }
    }
    ```

4. **Actual Issue**: The workflow appears to hang during the "waiting for services to stabilize" phase, but the services ARE actually stable and the deployment DID succeed.

### Root Cause Analysis

#### 1. **Workflow Timeout/Hanging Issue**

The main issue is not with the deployment itself, but with the workflow's service stabilization detection logic:

-   **Services are actually stable**: All ECS services show correct task counts and healthy status
-   **Endpoints are working**: HTTP/HTTPS health checks return 200 OK
-   **New code is deployed**: The health endpoint shows the correct git commit hash

#### 2. **Service Stabilization Detection Logic**

The issue is in the `waitForServicesStable` function in `deploy-code-only.ts`:

-   **Line 107**: The condition `service.deployments?.every((dep) => dep.status === 'STABLE')` may be too strict
-   **Deployment status ambiguity**: ECS deployments can be in various states during the stabilization process
-   **Multiple deployment objects**: There might be multiple deployment objects (old + new) where one is still in "PENDING" state

#### 3. **Missing Comprehensive Health Validation**

While the deployment worked, the workflow lacks the comprehensive validation steps from `deploy.yml`:

-   **No health endpoint validation** after deployment
-   **No integration tests** to verify functionality
-   **No build information validation** to confirm the right version is deployed

#### 4. **Workflow Design Issue**

The workflow design doesn't account for the fact that:

-   **ECS stabilization can take time**: Services might be healthy but still show "PENDING" deployments
-   **Force deployment behavior**: `forceNewDeployment: true` creates overlapping deployments
-   **SSM parameter timing**: The script updates SSM parameters but doesn't validate they're being used

## Key Differences: deploy-code.yml vs deploy.yml

| Feature                      | deploy.yml                     | deploy-code.yml                  | Status          |
| ---------------------------- | ------------------------------ | -------------------------------- | --------------- |
| Docker Image Build           | ✅ Full build process          | ❌ Uses pre-built image          | Expected        |
| Task Definition Update       | ✅ Creates new task definition | ✅ **WORKS** (forces deployment) | **WORKING**     |
| Service Stabilization        | ✅ Comprehensive waiting       | ⚠️ Hangs but services are stable | **NEEDS FIX**   |
| Health Validation            | ✅ Multiple health checks      | ❌ Missing validation            | **IMPROVEMENT** |
| Monitoring Scripts           | ✅ Full monitoring suite       | ❌ Missing scripts               | **IMPROVEMENT** |
| Post-deployment Tests        | ✅ Integration tests           | ❌ No tests                      | **IMPROVEMENT** |
| Build Information Validation | ✅ Validates build info        | ❌ Missing validation            | **IMPROVEMENT** |

## Required Fixes

### 1. **Fix Service Stabilization Detection**

The main issue is in the `waitForServicesStable` function in `deploy-code-only.ts`. The current logic is too strict:

```typescript
// Current problematic logic (line 107):
const isStable = service.deployments?.every((dep) => dep.status === 'STABLE') ?? false;

// Better approach - focus on running task counts:
const isStable = service.runningCount >= service.desiredCount && service.desiredCount > 0;
```

**Problem**: When `forceNewDeployment: true` is used, ECS creates overlapping deployments. The old deployment might still be in "PENDING" state while the new one is "STABLE".

**Solution**: For code deployments, focus on whether the correct number of tasks are running, rather than deployment status.

### 2. **Improve Stabilization Logic**

Replace the `waitForServicesStable` function with more robust logic:

```typescript
async function waitForServicesStable(
    ecsClient: ECSClient,
    serviceInfo: ServiceInfo,
    timeoutMinutes: number = 10,
): Promise<void> {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const startTime = Date.now();
    const checkInterval = 30 * 1000;

    console.log(`⏳ Waiting for services to stabilize (timeout: ${timeoutMinutes} minutes)...`);

    while (Date.now() - startTime < timeoutMs) {
        const healthChecks = await Promise.all([
            checkServiceStability(ecsClient, serviceInfo.cluster, serviceInfo.services.api),
            checkServiceStability(ecsClient, serviceInfo.cluster, serviceInfo.services.worker),
            checkServiceStability(ecsClient, serviceInfo.cluster, serviceInfo.services.scheduler),
        ]);

        if (healthChecks.every((stable) => stable)) {
            console.log('✅ All services are stable and healthy');
            return;
        }

        console.log(`⏳ Services not yet stable, waiting ${checkInterval / 1000}s before next check...`);
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    throw new Error(`❌ Services did not stabilize within ${timeoutMinutes} minutes`);
}

async function checkServiceStability(
    ecsClient: ECSClient,
    cluster: string,
    serviceName: string,
    isCritical: boolean = true,
): Promise<boolean> {
    try {
        const response = await ecsClient.send(
            new DescribeServicesCommand({
                cluster,
                services: [serviceName],
            }),
        );

        const service = response.services?.[0];
        if (!service) {
            console.log(`⚠️  Service ${serviceName} not found`);
            return false;
        }

        const runningCount = service.runningCount || 0;
        const desiredCount = service.desiredCount || 0;
        const serviceType = isCritical ? 'CRITICAL' : 'NON-CRITICAL';

        // Debug output for service deployments
        console.log(`🔍 [${serviceType}] ${serviceName} - Deployment states:`);
        service.deployments?.forEach((dep, index) => {
            console.log(`  Deployment ${index + 1}:`);
            console.log(`    Status: ${dep.status}`);
            console.log(`    Running: ${dep.runningCount}/${dep.desiredCount}`);
            console.log(`    Created: ${dep.createdAt?.toISOString()}`);
            console.log(`    Updated: ${dep.updatedAt?.toISOString()}`);
        });

        // Check if service has correct task counts (primary indicator)
        const hasCorrectTaskCounts = runningCount >= desiredCount && desiredCount > 0;

        // For code deployments, if tasks are running correctly, the service is healthy
        // We don't need to be overly strict about deployment status
        const isHealthy = hasCorrectTaskCounts;

        console.log(
            `📊 [${serviceType}] ${serviceName}: ${runningCount}/${desiredCount} tasks running, healthy: ${isHealthy}`,
        );

        return isHealthy;
    } catch (error) {
        console.error(`❌ Failed to check service stability for ${serviceName}:`, error);
        return false;
    }
}
```

### 3. **Add Health Validation to Workflow**

Enhance the `deploy-code.yml` workflow with post-deployment validation:

```yaml
- name: Health Check and Validation
  timeout-minutes: 5
  run: |
      cd infrastructure
      echo "🏥 Running post-deployment health checks..."

      # Wait for services to be fully ready
      sleep 30

      # Basic health check using existing status script
      npm run check-status:${{ needs.setup.outputs.environment }} || {
        echo "❌ Health check failed"
        echo "Services may be running but not responding correctly"
        exit 1
      }

      echo "✅ All health checks passed"

- name: Validate Build Information
  run: |
      echo "🔍 Validating deployed build information..."

      # Get environment-specific health URL
      HEALTH_URL="https://staging-api.hyperchonk.com/health"

      # Fetch health endpoint
      HEALTH_RESPONSE=$(curl -s --max-time 10 "$HEALTH_URL")

      # Extract git hash from response
      DEPLOYED_HASH=$(echo "$HEALTH_RESPONSE" | jq -r '.build.gitCommit.shortHash // "unknown"')
      EXPECTED_HASH="${{ needs.setup.outputs.image-tag }}"

      echo "📊 Deployed hash: $DEPLOYED_HASH"
      echo "📊 Expected hash: $EXPECTED_HASH"

      if [[ "$DEPLOYED_HASH" == *"$EXPECTED_HASH"* ]]; then
        echo "✅ Build information validation passed"
      else
        echo "❌ Build information validation failed"
        echo "Expected hash not found in deployed version"
        exit 1
      fi
```

### 4. **Prioritize Critical Services for Code Deployment**

Since we're only deploying code (Docker images), we should focus on the services that are critical for the deployment to be considered successful:

**Critical Services (must be stable):**

-   `api-service` - Main API endpoints, user-facing
-   `worker-service` - Background job processing, affects functionality

**Non-Critical Services (can be checked but not block deployment):**

-   `scheduler-service` - Cron jobs, can lag behind without immediate impact

**Enhanced Service Checking Logic:**

```typescript
async function waitForServicesStable(
    ecsClient: ECSClient,
    serviceInfo: ServiceInfo,
    timeoutMinutes: number = 10,
): Promise<void> {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const startTime = Date.now();
    const checkInterval = 30 * 1000;

    console.log(`⏳ Waiting for critical services to stabilize (timeout: ${timeoutMinutes} minutes)...`);

    while (Date.now() - startTime < timeoutMs) {
        // Check critical services first
        const criticalChecks = await Promise.all([
            checkServiceStability(ecsClient, serviceInfo.cluster, serviceInfo.services.api, true),
            checkServiceStability(ecsClient, serviceInfo.cluster, serviceInfo.services.worker, true),
        ]);

        // Check non-critical services (don't block deployment)
        const nonCriticalChecks = await Promise.all([
            checkServiceStability(ecsClient, serviceInfo.cluster, serviceInfo.services.scheduler, false),
        ]);

        const criticalStable = criticalChecks.every((stable) => stable);
        const nonCriticalStable = nonCriticalChecks.every((stable) => stable);

        if (criticalStable) {
            console.log('✅ All critical services are stable and healthy');

            if (nonCriticalStable) {
                console.log('✅ All non-critical services are also stable');
            } else {
                console.log('⚠️ Some non-critical services are still stabilizing (not blocking deployment)');
            }

            return;
        }

        console.log(`⏳ Critical services not yet stable, waiting ${checkInterval / 1000}s before next check...`);
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    throw new Error(`❌ Critical services did not stabilize within ${timeoutMinutes} minutes`);
}
```

## Summary

**CORRECTED ANALYSIS**: The deployment is actually **WORKING CORRECTLY**. The issue is not with the deployment itself, but with the workflow's service stabilization detection logic.

### What's Actually Happening:

1. **✅ Deployment is successful**: All services are running the correct code (confirmed by health endpoint showing correct git hash)
2. **✅ Infrastructure is healthy**: All ECS services, load balancers, and endpoints are working
3. **❌ Workflow hangs**: The stabilization detection logic is too strict and gets stuck waiting

### Root Cause:

The `waitForServicesStable` function uses `service.deployments?.every((dep) => dep.status === 'STABLE')` which requires ALL deployments to be stable. When using `forceNewDeployment: true`, ECS creates overlapping deployments where old ones might still be "PENDING" while new ones are "STABLE".

### Priority Fixes:

1. **HIGH PRIORITY**: Fix the service stabilization detection logic to check for ANY stable deployment with correct task counts
2. **MEDIUM PRIORITY**: Add health validation steps to the workflow for better confidence
3. **LOW PRIORITY**: Add build information validation to confirm the right version is deployed

### The Good News:

-   The deployment mechanism itself works correctly
-   Services are getting updated with new Docker images
-   The infrastructure is healthy and responding correctly
-   This is a workflow UX issue, not a deployment failure

### Quick Fix:

The fastest solution is to update the stabilization logic in `deploy-code-only.ts` to use `some()` instead of `every()` when checking deployment status, and add a timeout fallback in the workflow that validates service health even if the stabilization check hangs.
