# Multi-stage Dockerfile for Balancer v3 Backend with Bun
# Stage 1: Build dependencies and application
FROM oven/bun:1 AS builder

# Install system dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    openssl \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Create app directory and user
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs nodejs

# Set working directory
WORKDIR /app

# Copy package files first (better Docker layer caching)
COPY package.json bun.lockb ./

# Install dependencies with Bun (including devDependencies for build)
# Add timeout and retry logic to handle network issues on first run
RUN set -ex && \
    timeout 90 bun install --frozen-lockfile --no-progress --no-summary || \
    (echo "⚠️  First install attempt timed out, retrying..." && \
     sleep 5 && \
     bun install --frozen-lockfile --no-progress --no-summary)

# Copy Prisma schema separately (for better caching)
COPY prisma ./prisma/

# Generate Prisma client with timeout and retry logic
# Set memory limit and disable telemetry for faster generation
ENV PRISMA_TELEMETRY_DISABLED=1
RUN set -ex && \
    echo "🔄 Generating Prisma client..." && \
    timeout 30 bunx --bun prisma generate || \
    (echo "⚠️  First Prisma generation attempt timed out, retrying..." && \
     sleep 10 && \
     timeout 30 bunx --bun prisma generate) && \
    echo "✅ Prisma client generated successfully"

# Copy application code
COPY . .

# Accept build arguments for non-sensitive environment variables
# Sensitive API keys will be provided via BuildKit secrets
ARG ADMIN_API_KEY=local-admin-key-123
ARG SANITY_API_TOKEN=demo-token
ARG SENTRY_DSN=https://demo@demo.ingest.sentry.io/demo
ARG SENTRY_AUTH_TOKEN=demo-token
ARG DATABASE_URL=postgresql://backend:let-me-in@postgres:5432/database?schema=public
ARG DEFAULT_CHAIN_ID=250
ARG NODE_ENV=development
ARG ENVIRONMENT=local
ARG AWS_REGION=us-east-1
ARG WHITELISTED_CHAINS=250

# Accept build information arguments
ARG BUILD_VERSION=0.0.0
ARG BUILD_GIT_HASH=unknown
ARG BUILD_GIT_SHORT_HASH=unknown
ARG BUILD_TIME=unknown
ARG DEPLOYMENT_TIME=unknown

# Set environment variables for GraphQL generation
# Note: THEGRAPH_API_KEY_* will be set via BuildKit secrets in the RUN command
ENV ADMIN_API_KEY=${ADMIN_API_KEY} \
    SANITY_API_TOKEN=${SANITY_API_TOKEN} \
    SENTRY_DSN=${SENTRY_DSN} \
    SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN} \
    DATABASE_URL=${DATABASE_URL} \
    DEFAULT_CHAIN_ID=${DEFAULT_CHAIN_ID} \
    PORT=4000 \
    NODE_ENV=${NODE_ENV} \
    DEPLOYMENT_ENV=${ENVIRONMENT} \
    AWS_REGION=${AWS_REGION} \
    LOG_LEVEL=debug \
    WHITELISTED_CHAINS=${WHITELISTED_CHAINS}

# Set build information environment variables
ENV BUILD_VERSION=${BUILD_VERSION} \
    BUILD_GIT_HASH=${BUILD_GIT_HASH} \
    BUILD_GIT_SHORT_HASH=${BUILD_GIT_SHORT_HASH} \
    BUILD_TIME=${BUILD_TIME} \
    DEPLOYMENT_TIME=${DEPLOYMENT_TIME}

# Generate GraphQL schema with BuildKit secrets for API keys
# Secrets are mounted temporarily and never stored in image layers
RUN --mount=type=secret,id=thegraph_balancer,required=false \
    --mount=type=secret,id=thegraph_fantom,required=false \
    set -ex && \
    # Set API keys from secrets if available, fallback to demo keys for local builds
    export THEGRAPH_API_KEY_BALANCER=$([ -f /run/secrets/thegraph_balancer ] && cat /run/secrets/thegraph_balancer || echo "demo-key") && \
    export THEGRAPH_API_KEY_FANTOM=$([ -f /run/secrets/thegraph_fantom ] && cat /run/secrets/thegraph_fantom || echo "demo-key") && \
    echo "🔄 Generating GraphQL schemas with secure API keys..." && \
    bun run generate && \
    echo "✅ GraphQL schemas generated successfully"

# Build the application
RUN bun run build

# Stage 2: Development stage (for hot reloading)
FROM oven/bun:1 AS development

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    openssl \
    dumb-init \
    curl \
    procps \
    htop \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs nodejs

# Set working directory
WORKDIR /app

# Copy package files for development install (includes devDependencies)
COPY package.json bun.lockb ./

# Install ALL dependencies (including devDependencies for development)
RUN set -ex && \
    timeout 90 bun install --frozen-lockfile --no-progress --no-summary || \
    (echo "⚠️  Development install attempt timed out, retrying..." && \
     sleep 5 && \
     bun install --frozen-lockfile --no-progress --no-summary)

# Copy Prisma schema and pre-generated client from builder stage
COPY prisma ./prisma/
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Accept build arguments for development stage (keeping for compatibility)
ARG ADMIN_API_KEY=local-admin-key-123
ARG SANITY_API_TOKEN=demo-token
ARG SENTRY_DSN=https://demo@demo.ingest.sentry.io/demo
ARG SENTRY_AUTH_TOKEN=demo-token
ARG DATABASE_URL=postgresql://backend:let-me-in@postgres:5432/database?schema=public
ARG DEFAULT_CHAIN_ID=250
ARG NODE_ENV=development
ARG ENVIRONMENT=local
ARG AWS_REGION=us-east-1
ARG WHITELISTED_CHAINS=250
# Development stage can use ARG for API keys since it's for local development
ARG THEGRAPH_API_KEY_BALANCER=demo-key
ARG THEGRAPH_API_KEY_FANTOM=demo-key

# Set environment variables for development stage
# Development stage can use ARG-based API keys since it's for local development
ENV THEGRAPH_API_KEY_BALANCER=${THEGRAPH_API_KEY_BALANCER} \
    THEGRAPH_API_KEY_FANTOM=${THEGRAPH_API_KEY_FANTOM} \
    ADMIN_API_KEY=${ADMIN_API_KEY} \
    SANITY_API_TOKEN=${SANITY_API_TOKEN} \
    SENTRY_DSN=${SENTRY_DSN} \
    SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN} \
    DATABASE_URL=${DATABASE_URL} \
    DEFAULT_CHAIN_ID=${DEFAULT_CHAIN_ID} \
    PORT=4000 \
    NODE_ENV=${NODE_ENV} \
    DEPLOYMENT_ENV=${ENVIRONMENT} \
    AWS_REGION=${AWS_REGION} \
    LOG_LEVEL=debug \
    WHITELISTED_CHAINS=${WHITELISTED_CHAINS}

# Copy source code (will be overridden by volume mount in dev mode)
COPY . .

# Generate GraphQL schema in development (uses ARG-based API keys)
RUN echo "🔄 Generating GraphQL schemas for development..." && \
    bun run generate && \
    echo "✅ Development GraphQL schemas generated successfully"

# Fix permissions before switching to nodejs user
RUN chown -R nodejs:nodejs /app

# Create necessary directories
RUN mkdir -p logs tmp

# Copy and set up entrypoint script
COPY --chown=nodejs:nodejs scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 4000

# Use dumb-init and our entrypoint script
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]

# Default command for development (hot reloading)
CMD ["bun", "run", "dev"]

# Stage 3: Production runtime
FROM oven/bun:1 AS runtime

# Install runtime system dependencies including process tools
RUN apt-get update && apt-get install -y \
    curl \
    dumb-init \
    procps \
    redis-tools \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs nodejs

# Set working directory
WORKDIR /app

# Copy package files and install only production dependencies
COPY package.json bun.lockb ./

# Accept build information arguments for runtime
ARG BUILD_VERSION=0.0.0
ARG BUILD_GIT_HASH=unknown
ARG BUILD_GIT_SHORT_HASH=unknown
ARG BUILD_TIME=unknown
ARG DEPLOYMENT_TIME=unknown

RUN set -ex && \
    timeout 90 bun install --frozen-lockfile --production --no-progress --no-summary || \
    (echo "⚠️  Production install attempt timed out, retrying..." && \
     sleep 5 && \
     bun install --frozen-lockfile --production --no-progress --no-summary)

# Copy pre-built and pre-generated artifacts from builder stage
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma

# Note: TypeScript source directories (apps/, modules/, config/) are NOT needed 
# at runtime since everything is compiled into the standalone dist/ directory

# Copy scripts and make them executable
COPY --chown=nodejs:nodejs scripts/ ./scripts/
RUN chmod +x ./scripts/*.sh ./scripts/*.js

# Copy entrypoint script
COPY --chown=nodejs:nodejs scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create necessary directories and fix permissions
RUN mkdir -p logs tmp && \
    chown -R nodejs:nodejs /app

# Set build information environment variables for runtime
ENV BUILD_VERSION=${BUILD_VERSION} \
    BUILD_GIT_HASH=${BUILD_GIT_HASH} \
    BUILD_GIT_SHORT_HASH=${BUILD_GIT_SHORT_HASH} \
    BUILD_TIME=${BUILD_TIME} \
    DEPLOYMENT_TIME=${DEPLOYMENT_TIME}

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 4000

# Health check that works for all service types
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD if [ "$WORKER" = "true" ]; then \
        curl -f http://localhost:8080/health/deep || exit 1; \
      elif [ "$SCHEDULER" = "true" ]; then \
        curl -f http://localhost:8081/health/deep || exit 1; \
      else \
        curl -f http://localhost:4000/health || exit 1; \
      fi

# Use dumb-init and our entrypoint script
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]

# Default command (can be overridden for different services)
CMD ["bun", "run", "start"] 
