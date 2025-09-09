# Infrastructure and Code Deployment Separation Plan

## Current State Analysis

### Current Tight Coupling
The current deployment workflow (.github/workflows/deploy.yml) tightly couples code and infrastructure deployment:

1. **Single Deploy Workflow**: One workflow handles both Docker building and CDK deployment
2. **Image URI Dependency**: Infrastructure deployment requires `imageUri` context from freshly built Docker image
3. **Sequential Process**: Code build → Image push → Infrastructure deployment with new image URI
4. **Force Deployment Context**: Uses `deploymentTimestamp` and `deploymentId` to force ECS updates

### Key Coupling Points Identified

#### 1. Docker Image URI Coupling
**File**: `infrastructure/lib/stacks/compute-stack.ts:325`
```typescript
const imageUri = this.node.tryGetContext('imageUri') || 'public.ecr.aws/docker/library/node:18-alpine';
```

#### 2. Force Deployment Context
**File**: `infrastructure/lib/stacks/compute-stack.ts:329-337`
```typescript
const deploymentTimestamp = this.node.tryGetContext('deploymentTimestamp') || new Date().toISOString();
const deploymentId = this.node.tryGetContext('deploymentId') || Date.now().toString();
```

#### 3. Build-time Environment Variables
**File**: `Dockerfile:49-61` - Build args required for GraphQL generation during Docker build
- External API dependencies: THEGRAPH_API_KEY_BALANCER, THEGRAPH_API_KEY_FANTOM
- Schema generation from live GraphQL endpoints (config/fantom.ts:16-20)
- Type safety requirements for TypeScript compilation

#### 4. Deployment Workflow Dependencies
**File**: `.github/workflows/deploy.yml:645-713` - Infrastructure deployment depends on Docker image build

## Proposed Separation Strategy

### 1. Leverage Existing Infrastructure

#### A. Extend Existing Deployment Scripts
The codebase has sophisticated deployment infrastructure in `infrastructure/scripts/`:
- `deploy-sequential.ts` - Multi-phase deployment with recovery
- `deploy-with-recovery.ts` - Circuit breaker and rollback automation  
- `deployment-monitor.ts` - Real-time monitoring and health checks
- `status-checker/ecs-checker.ts` - Comprehensive ECS diagnostics

**Strategy**: Extend existing tools rather than replacing them.

### 2. Create Separate Workflows

#### A. Infrastructure Deployment Workflow (`deploy-infra.yml`)
```yaml
name: Deploy Infrastructure

on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy to'
        required: true
        type: choice
        options: [dev, staging, production]
      image_tag:
        description: 'Docker image tag to deploy (e.g., sha-abc123 or latest)'
        required: true
        type: string
      confirm_production:
        description: 'Type "DEPLOY TO PRODUCTION" to confirm'
        required: false
        default: ''

jobs:
  deploy-infrastructure:
    name: Deploy Infrastructure
    runs-on: ubuntu-latest
    steps:
      - name: Validate Production Confirmation
        if: inputs.environment == 'production'
        run: |
          if [ "${{ inputs.confirm_production }}" != "DEPLOY TO PRODUCTION" ]; then
            echo "❌ Production deployment confirmation required"
            exit 1
          fi
      
      - name: Checkout Infrastructure Code
        uses: actions/checkout@v4
        with:
          sparse-checkout: |
            infrastructure/
            .github/workflows/
          
      - name: Resolve Image URI
        run: |
          ECR_REGISTRY="${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.us-east-1.amazonaws.com"
          IMAGE_URI="${ECR_REGISTRY}/balancer-api:${{ inputs.image_tag }}"
          
          # Verify image exists
          aws ecr describe-images \
            --repository-name balancer-api \
            --image-ids imageTag=${{ inputs.image_tag }} \
            --region us-east-1
          
          echo "IMAGE_URI=$IMAGE_URI" >> $GITHUB_ENV
          
      - name: Deploy Infrastructure
        run: |
          cd infrastructure
          npx cdk deploy --all \
            --require-approval never \
            --context environment=${{ inputs.environment }} \
            --context imageUri=$IMAGE_URI
```

#### B. Code Deployment Workflow (`deploy-code.yml`)
```yaml
name: Deploy Code Only

on:
  push:
    branches: [develop, staging, main]
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy to'
        required: true
        type: choice
        options: [dev, staging, production]

jobs:
  deploy-code:
    name: Build and Deploy Code
    runs-on: ubuntu-latest
    steps:
      - name: Setup Docker Buildx
        uses: docker/setup-buildx-action@v3
        
      - name: Build and Push Docker Image with BuildKit Secrets
        run: |
          IMAGE_TAG="sha-${{ github.sha }}"
          
          # Build with secrets mounted temporarily (not stored in layers)
          echo "${{ secrets.THEGRAPH_API_KEY_BALANCER }}" | docker buildx build \
            --secret id=thegraph_balancer,src=- \
            --secret id=thegraph_fantom,src=<(echo "${{ secrets.THEGRAPH_API_KEY_FANTOM }}") \
            --platform linux/amd64 \
            -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG \
            --push .
          
          # Tag as environment-latest
          docker buildx imagetools create \
            $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG \
            --tag $ECR_REGISTRY/$ECR_REPOSITORY:${{ env.ENVIRONMENT }}-latest
          
      - name: Use Existing ECS Update Scripts
        run: |
          cd infrastructure
          # Use existing sophisticated deployment tooling
          npm run deploy:${{ env.ENVIRONMENT }}:code-only
```

### 3. Modify CDK Infrastructure Code

#### A. Decouple Image URI from Context
**File**: `infrastructure/lib/stacks/compute-stack.ts`

```typescript
// Before:
const imageUri = this.node.tryGetContext('imageUri') || 'public.ecr.aws/docker/library/node:18-alpine';

// After:
private getImageUri(): string {
  // Priority order:
  // 1. Explicit context (for infra deployment)
  // 2. Environment-specific latest tag
  // 3. Fallback to current production image
  
  const contextImageUri = this.node.tryGetContext('imageUri');
  if (contextImageUri) {
    return contextImageUri;
  }
  
  const ecrRegistry = `${this.account}.dkr.ecr.${this.region}.amazonaws.com`;
  const repository = 'balancer-api';
  
  // Use environment-specific latest tag
  return `${ecrRegistry}/${repository}:${this.config.environment}-latest`;
}
```

#### B. Create Image Tag Parameter
**File**: `infrastructure/lib/stacks/compute-stack.ts`

```typescript
// Add SSM parameter for current image tag
const currentImageTag = new ssm.StringParameter(this, 'CurrentImageTag', {
  parameterName: getSsmParameterName('compute', 'currentImageTag', config.environment),
  stringValue: this.getImageTag(),
  description: `Current Docker image tag for ${config.environment}`,
});

private getImageTag(): string {
  return this.node.tryGetContext('imageTag') || `${this.config.environment}-latest`;
}
```

### 4. Update Docker Configuration

#### A. Use BuildKit Secrets for Secure Build-time Dependencies
**File**: `Dockerfile`

```dockerfile
# Remove ARG declarations for secrets
# ARG THEGRAPH_API_KEY_BALANCER=demo-key
# ARG THEGRAPH_API_KEY_FANTOM=demo-key

# Use BuildKit secrets during GraphQL generation
RUN --mount=type=secret,id=thegraph_balancer \
    --mount=type=secret,id=thegraph_fantom \
    THEGRAPH_API_KEY_BALANCER=$(cat /run/secrets/thegraph_balancer) \
    THEGRAPH_API_KEY_FANTOM=$(cat /run/secrets/thegraph_fantom) \
    bun run generate
```

**Benefits**:
- Maintains type safety from build-time schema generation
- Secrets never stored in Docker image layers
- No runtime performance impact
- Preserves existing TypeScript compilation

#### B. Keep Multi-Stage Build Structure
**File**: `Dockerfile`

```dockerfile
# Current multi-stage build is already well-structured
# Just update secret handling in builder stage
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .

# Secure secret mounting for GraphQL generation
RUN --mount=type=secret,id=thegraph_balancer \
    --mount=type=secret,id=thegraph_fantom \
    THEGRAPH_API_KEY_BALANCER=$(cat /run/secrets/thegraph_balancer) \
    THEGRAPH_API_KEY_FANTOM=$(cat /run/secrets/thegraph_fantom) \
    bun run generate

RUN bun run build

# Runtime stage remains unchanged
FROM oven/bun:1 AS runtime
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
```

### 5. ECS Service Update Strategy

#### A. Leverage Existing ECS Management Tools
**Files**: `infrastructure/scripts/status-checker/ecs-checker.ts`, `infrastructure/scripts/deployment-monitor.ts`

The codebase already has sophisticated ECS management:
- Three services: API, Worker, Scheduler (compute-stack.ts:183-185)
- Advanced auto-scaling configurations
- Environment-specific deployment strategies
- Circuit breaker and rollback automation

**Strategy**: Build on existing infrastructure rather than replacing.

#### B. Extend Existing ECS Update Scripts
**File**: `infrastructure/scripts/update-ecs-services.ts`

```typescript
import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';

interface UpdateServicesConfig {
  environment: string;
  imageTag: string;
  cluster: string;
  services: string[];
}

export async function updateEcsServices(config: UpdateServicesConfig) {
  const ecsClient = new ECSClient({ region: 'us-east-1' });
  
  // Update SSM parameter with new image tag
  await updateImageTagParameter(config.environment, config.imageTag);
  
  // Force new deployment for all services
  for (const service of config.services) {
    await ecsClient.send(new UpdateServiceCommand({
      cluster: config.cluster,
      service: service,
      forceNewDeployment: true,
      taskDefinition: await getLatestTaskDefinition(service),
    }));
  }
}

async function updateImageTagParameter(environment: string, imageTag: string) {
  const ssmClient = new SSMClient({ region: 'us-east-1' });
  
  await ssmClient.send(new PutParameterCommand({
    Name: `/v3-backend/${environment}/compute/currentImageTag`,
    Value: imageTag,
    Overwrite: true,
  }));
}
```

#### C. Task Definition and Migration Handling
**File**: `infrastructure/scripts/update-task-definition.ts`

```typescript
export async function updateTaskDefinitionImage(
  taskDefinitionArn: string,
  newImageUri: string
): Promise<string> {
  const ecsClient = new ECSClient({ region: 'us-east-1' });
  
  // Handle all four task definition types:
  // 1. API (apiTaskDefinition)
  // 2. Worker (workerTaskDefinition) 
  // 3. Scheduler (schedulerTaskDefinition)
  // 4. Migration (migrationTaskDefinition)
  
  const current = await ecsClient.send(new DescribeTaskDefinitionCommand({
    taskDefinition: taskDefinitionArn,
  }));
  
  // Update container image
  const updatedContainers = current.taskDefinition?.containerDefinitions?.map(container => ({
    ...container,
    image: container.name === 'v3-backend-api' || 
           container.name === 'v3-backend-worker' || 
           container.name === 'v3-backend-scheduler' ||
           container.name === 'v3-backend-migration' 
           ? newImageUri : container.image,
  }));
  
  const newTaskDef = await ecsClient.send(new RegisterTaskDefinitionCommand({
    family: current.taskDefinition?.family,
    containerDefinitions: updatedContainers,
    // Preserve all existing task definition properties
    taskRoleArn: current.taskDefinition?.taskRoleArn,
    executionRoleArn: current.taskDefinition?.executionRoleArn,
    networkMode: current.taskDefinition?.networkMode,
    requiresCompatibilities: current.taskDefinition?.requiresCompatibilities,
    cpu: current.taskDefinition?.cpu,
    memory: current.taskDefinition?.memory,
  }));
  
  return newTaskDef.taskDefinition?.taskDefinitionArn!;
}
```

### 6. Stack Architecture Considerations

#### A. Shared vs. Separated Resources
**Current State**: All three services (API, Worker, Scheduler) share:
- ECS Cluster
- Application Load Balancer (ALB)
- Security groups and networking
- Monitoring and logging infrastructure

**Recommendation**: Keep shared infrastructure together, separate only service definitions:
- `compute-shared-stack.ts`: Cluster, ALB, networking
- `api-service-stack.ts`: API service and task definition
- `worker-service-stack.ts`: Worker service and task definition
- `scheduler-service-stack.ts`: Scheduler service and task definition

#### B. Monitoring Stack Dependencies
**Files**: `monitoring-stack.ts`, `log-forwarder-stack.ts`

These stacks reference compute stack services directly. Updates needed:
- Use service lookups instead of direct references
- Update log group ARN resolution for separated stacks

### 7. Migration Strategy

#### Phase 1: Parallel Workflows (Week 1-2)
1. Create `deploy-infra.yml` workflow alongside existing `deploy.yml`
2. Create `deploy-code.yml` workflow
3. Test both workflows in development environment
4. Validate image URI resolution and ECS service updates

#### Phase 2: CDK Code Updates (Week 2-3)
1. Implement `getImageUri()` method with fallback logic
2. Add SSM parameter for current image tag tracking
3. Extend existing ECS service update scripts
4. Update Docker build to use BuildKit secrets (maintain build-time generation)
5. Update monitoring and log-forwarder stack references

#### Phase 3: Workflow Transition (Week 3-4)
1. Switch development environment to use new workflows
2. Update staging environment after validation
3. Migrate production environment with careful rollback plan
4. Remove old `deploy.yml` workflow

#### Phase 4: Optimization (Week 4-5)
1. Implement task definition caching
2. Add workflow dependency management
3. Create monitoring and alerting for separated deployments
4. Document new deployment process

### 8. Benefits of This Approach

#### Operational Benefits
- **Independent Scaling**: Infrastructure and code can be deployed independently
- **Reduced Blast Radius**: Infrastructure changes don't affect code deployments
- **Faster Code Deployments**: No CDK synthesis required for code changes
- **Selective Rollbacks**: Can rollback code without infrastructure changes

#### Development Benefits
- **Cleaner Separation**: Clear boundaries between infrastructure and application concerns
- **Parallel Development**: Infrastructure and application teams can work independently
- **Flexible Deployment**: Deploy any image to any environment via UI
- **Reduced Complexity**: Simpler troubleshooting and debugging

#### Security Benefits
- **Minimal Access**: Code deployment only needs ECS permissions
- **Audit Trail**: Clear separation of infrastructure vs. application changes
- **Principle of Least Privilege**: Different workflows have different permission requirements

#### Infrastructure Benefits
- **Leverage Existing Tools**: Build on sophisticated deployment infrastructure
- **Maintain Type Safety**: Keep build-time GraphQL generation with secure secrets
- **Shared Resource Optimization**: Keep cluster/ALB shared, separate only services
- **Monitoring Continuity**: Extend existing monitoring rather than rebuilding

### 9. Implementation Checklist

#### Infrastructure Changes
- [ ] Create `getImageUri()` method in ComputeStack
- [ ] Add SSM parameter for image tag tracking
- [ ] Create ECS service update scripts
- [ ] Update task definition management
- [ ] Add image tag validation

#### Workflow Changes
- [ ] Create `deploy-infra.yml` workflow
- [ ] Create `deploy-code.yml` workflow
- [ ] Add environment variable resolution
- [ ] Implement image URI validation
- [ ] Add production confirmation logic

#### Docker Changes
- [ ] Implement BuildKit secrets for secure build-time dependencies
- [ ] Update Dockerfile to use secret mounting
- [ ] Maintain GraphQL generation at build time for type safety
- [ ] Update GitHub Actions to use docker buildx with secrets

#### Testing & Validation
- [ ] Test infrastructure deployment with existing images
- [ ] Test code deployment with service updates
- [ ] Validate rollback procedures
- [ ] Performance testing for deployment speed
- [ ] Security validation for separated permissions

#### Additional Considerations
- [ ] Update monitoring stack service references
- [ ] Handle migration task definitions separately
- [ ] Extend existing npm deployment scripts
- [ ] Test BuildKit secret mounting in CI/CD
- [ ] Validate shared resource access across separated stacks

### 10. Rollback Plan

#### Emergency Rollback
1. **Immediate**: Revert to old `deploy.yml` workflow
2. **Service Recovery**: Use existing task definitions
3. **Image Recovery**: Use previous ECR image tags
4. **Infrastructure Recovery**: Use CDK rollback commands

#### Gradual Rollback
1. **Environment by Environment**: Start with development
2. **Workflow Selection**: Keep both workflows during transition
3. **Feature Flags**: Use environment variables to control deployment method
4. **Monitoring**: Comprehensive monitoring during transition period

### 11. Monitoring and Observability

#### Deployment Metrics
- **Deployment Duration**: Track time for infra vs. code deployments
- **Success Rate**: Monitor deployment success rates
- **Rollback Frequency**: Track rollback incidents
- **Resource Utilization**: Monitor ECS service performance

#### Alerting Strategy
- **Infrastructure Alerts**: CDK deployment failures
- **Code Deployment Alerts**: ECS service update failures
- **Image Validation Alerts**: ECR image availability issues
- **Health Check Alerts**: Service health after deployments

This plan provides a comprehensive strategy for separating infrastructure and code deployments while maintaining operational excellence and deployment reliability.