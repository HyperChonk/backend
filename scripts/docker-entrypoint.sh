#!/bin/bash

set -e

echo "🚀 Starting Balancer v3 Backend..."

# Enhanced function to wait for database to be ready with multiple checks
wait_for_db() {
    local max_attempts=60  # 2 minutes total
    local attempt=1
    local base_delay=2
    
    echo "⏳ Waiting for database to be ready..."
    
    while [ $attempt -le $max_attempts ]; do
        # Calculate progressive delay: min(base_delay * sqrt(attempt), 10)
        local delay=$(echo "scale=0; sqrt($attempt) * $base_delay" | bc -l 2>/dev/null || echo $base_delay)
        if [ $(echo "$delay > 10" | bc -l 2>/dev/null || echo "0") -eq 1 ]; then
            delay=10
        fi
        
        echo "🔍 Database readiness check (attempt $attempt/$max_attempts)..."
        
        # Test 1: Basic connection test
        if bunx prisma db execute --stdin <<< "SELECT 1;" > /dev/null 2>&1; then
            echo "✅ Basic database connection successful"
            
            # Test 2: Check if database schema exists and is accessible
            if bunx prisma db execute --stdin <<< "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' LIMIT 1;" > /dev/null 2>&1; then
                echo "✅ Database schema is accessible"
                
                # Test 3: Verify Prisma client can connect
                if timeout 10 bun -e "
                    import { PrismaClient } from '@prisma/client';
                    const prisma = new PrismaClient();
                    prisma.\$connect().then(() => {
                        console.log('Prisma client connected successfully');
                        process.exit(0);
                    }).catch((e) => {
                        console.error('Prisma client connection failed:', e.message);
                        process.exit(1);
                    });
                " 2>/dev/null; then
                    echo "✅ Prisma client connection verified"
                    echo "✅ Database is fully ready and operational!"
                    return 0
                else
                    echo "⚠️  Database connected but Prisma client failed. Retrying in $delay seconds..."
                fi
            else
                echo "⚠️  Database connected but schema not accessible. Retrying in $delay seconds..."
            fi
        else
            echo "⚠️  Database connection failed. Retrying in $delay seconds..."
        fi
        
        sleep $delay
        attempt=$((attempt + 1))
    done
    
    echo "❌ Database failed to become ready after $max_attempts attempts"
    echo "🔍 Final diagnostic information:"
    echo "   - DATABASE_URL: ${DATABASE_URL:-not set}"
    echo "   - Attempting to show last few Postgres logs..."
    
    # Try to get some diagnostic info (may fail in some environments)
    timeout 5 bunx prisma db execute --stdin <<< "SELECT version();" 2>&1 || echo "   Could not retrieve database version"
    
    return 1
}

# Enhanced function to wait for Redis to be ready
wait_for_redis() {
    local max_attempts=30  # 1 minute total
    local attempt=1
    local base_delay=2
    
    echo "⏳ Waiting for Redis to be ready..."
    
    while [ $attempt -le $max_attempts ]; do
        echo "🔍 Redis readiness check (attempt $attempt/$max_attempts)..."
        
        # Try to ping Redis using redis-cli
        if timeout 3 redis-cli -h redis -p 6379 ping >/dev/null 2>&1; then
            echo "✅ Redis is ready and operational!"
            return 0
        else
            echo "⚠️  Redis not ready. Retrying in $base_delay seconds..."
        fi
        
        sleep $base_delay
        attempt=$((attempt + 1))
    done
    
    echo "❌ Redis failed to become ready after $max_attempts attempts"
    echo "🔍 This is not critical for startup, continuing anyway..."
    return 1
}

# Enhanced function to wait for LocalStack services to be ready
wait_for_localstack() {
    local max_attempts=45  # 1.5 minutes total
    local attempt=1
    local base_delay=2
    
    echo "⏳ Waiting for LocalStack services to be ready..."
    
    while [ $attempt -le $max_attempts ]; do
        echo "🔍 LocalStack readiness check (attempt $attempt/$max_attempts)..."
        
        # Test LocalStack services using direct HTTP calls via curl
        if timeout 5 curl -f -s "http://localstack:4566/_localstack/health" | grep -q '"sqs": "running"' && \
           timeout 5 curl -f -s "http://localstack:4566/_localstack/health" | grep -q '"s3": "running"'; then
            echo "✅ LocalStack services (SQS & S3) are ready and operational!"
            return 0
        else
            echo "⚠️  LocalStack services not ready. Retrying in $base_delay seconds..."
        fi
        
        sleep $base_delay
        attempt=$((attempt + 1))
    done
    
    echo "❌ LocalStack services failed to become ready after $max_attempts attempts"
    echo "🔍 This is not critical for startup, continuing anyway..."
    return 1
}

# Function to wait for database schema to be ready
wait_for_schema_ready() {
    local max_attempts=90  # 3 minutes total
    local attempt=1
    local base_delay=2
    
    echo "🔍 Validating database schema is ready..."
    
    while [ $attempt -le $max_attempts ]; do
        # Calculate progressive delay similar to wait_for_db
        local delay=$(echo "scale=0; sqrt($attempt) * $base_delay" | bc -l 2>/dev/null || echo $base_delay)
        if [ $(echo "$delay > 10" | bc -l 2>/dev/null || echo "0") -eq 1 ]; then
            delay=10
        fi
        
        echo "📋 Schema validation check (attempt $attempt/$max_attempts)..."
        
        # Check if critical tables exist (PrismaToken is the one that failed in the error)
        if bunx prisma db execute --stdin <<< "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'PrismaToken');" 2>/dev/null | grep -q 't'; then
            echo "✅ Critical table 'PrismaToken' exists"
            
            # Additional check: ensure we can query the table
            if bunx prisma db execute --stdin <<< "SELECT COUNT(*) FROM \"PrismaToken\" LIMIT 1;" > /dev/null 2>&1; then
                echo "✅ Can query PrismaToken table successfully"
                
                # Final check: verify Prisma client can work with the schema
                if timeout 10 bun -e "
                    import { PrismaClient } from '@prisma/client';
                    const prisma = new PrismaClient();
                    prisma.prismaToken.count().then((count) => {
                        console.log('✅ Prisma client can access PrismaToken table');
                        process.exit(0);
                    }).catch((e) => {
                        console.error('Prisma client schema access failed:', e.message);
                        process.exit(1);
                    });
                " 2>/dev/null; then
                    echo "✅ Database schema is fully ready for worker operations!"
                    return 0
                else
                    echo "⚠️  Schema exists but Prisma client cannot access it. Retrying in $delay seconds..."
                fi
            else
                echo "⚠️  PrismaToken table exists but cannot be queried. Schema might be updating. Retrying in $delay seconds..."
            fi
        else
            echo "⚠️  Critical tables not found. Migrations might still be running. Retrying in $delay seconds..."
            
            # Log helpful debug info every 10 attempts
            if [ $((attempt % 10)) -eq 0 ]; then
                echo "📊 Current schema status:"
                bunx prisma db execute --stdin <<< "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name LIMIT 10;" 2>/dev/null || echo "   Could not list tables"
            fi
        fi
        
        sleep $delay
        attempt=$((attempt + 1))
    done
    
    echo "❌ Database schema validation failed after $max_attempts attempts"
    echo "🔍 Final diagnostic information:"
    echo "   - Service type: ${SERVICE_TYPE:-unknown}"
    echo "   - Environment: ${NODE_ENV:-unknown}"
    echo "   - Deployment environment: ${DEPLOYMENT_ENV:-unknown}"
    
    # Try to show what tables do exist
    echo "📊 Available tables in database:"
    bunx prisma db execute --stdin <<< "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;" 2>&1 || echo "   Could not retrieve table list"
    
    return 1
}

# Enhanced function to run migrations with retry logic
run_migrations() {
    local max_attempts=3
    local attempt=1
    
    echo "🗃️ Running database migrations..."
    
    while [ $attempt -le $max_attempts ]; do
        echo "📋 Migration attempt $attempt/$max_attempts..."
        
        # Check current migration status first (always runs, exit code doesn't matter)
        echo "   Checking current migration status..."
        bunx prisma migrate status || echo "   Found pending migrations (this is expected)"
        
        # Deploy migrations (Prisma client already generated during build)
        echo "   Deploying migrations..."
        if bunx prisma migrate deploy; then
            echo "✅ Migration deployment successful"
            
            # Verify final migration status
            echo "   Verifying final migration status..."
            if bunx prisma migrate status; then
                echo "✅ Database migrations completed successfully!"
                return 0
            else
                echo "⚠️  Migration deployed but status check failed. Attempt $attempt/$max_attempts"
            fi
        else
            echo "⚠️  Migration deployment failed. Attempt $attempt/$max_attempts"
        fi
        
        if [ $attempt -lt $max_attempts ]; then
            echo "⏳ Waiting 5 seconds before retry..."
            sleep 5
        fi
        
        attempt=$((attempt + 1))
    done
    
    echo "❌ Database migrations failed after $max_attempts attempts"
    echo "🔍 Diagnostic information:"
    echo "   - Attempting to show current migration status..."
    bunx prisma migrate status 2>&1 || echo "   Could not retrieve migration status"
    
    return 1
}

# Main execution
main() {
    echo "🔧 Service Type: ${SERVICE_TYPE:-api}"
    echo "🌿 Environment: ${NODE_ENV:-not set}"

    # For local development, we run comprehensive dependency checks.
    # For all deployed environments (development, staging, production), we only check the database.
    if [ "${NODE_ENV}" = "local" ]; then
        # Local development dependency checks
        echo "🛠️ Local environment detected. Running full dependency checks..."
        case "${SERVICE_TYPE:-api}" in
            "api")
                wait_for_db
                wait_for_redis || echo "⚠️  Redis check failed, but API will continue"
                wait_for_localstack || echo "⚠️  LocalStack check failed, but API will continue"
                run_migrations
                ;;
            *) # worker, scheduler, and others
                wait_for_db
                wait_for_redis || echo "⚠️  Redis check failed, but service will continue"
                wait_for_localstack || echo "⚠️  LocalStack check failed, but service will continue with retries"
                echo "⏭️ Skipping migrations (not API service)"
                ;;
        esac
    else
        echo "☁️ Deployed environment detected (${NODE_ENV}). Waiting for database only..."
        wait_for_db
        
        if [ "${SERVICE_TYPE:-api}" = "api" ]; then
            echo "🔍 API service detected. Running database migrations..."
            run_migrations
        else
            echo "🔍 ${SERVICE_TYPE:-worker} service detected. Validating database schema is ready..."
            # For non-API services in deployed environments, wait for schema to be ready
            # This prevents race conditions where worker starts before migrations complete
            if wait_for_schema_ready; then
                echo "✅ Database schema validated. Starting ${SERVICE_TYPE:-worker} service."
            else
                echo "❌ Failed to validate database schema. Service may encounter errors."
                # Still continue to start the service - it might recover with retries
            fi
        fi
    fi
    
    echo "🎉 Starting application..."
    
    # Execute the original command
    exec "$@"
}

# Run main function
main "$@" 
