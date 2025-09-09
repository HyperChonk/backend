# Docker Development Setup

This Docker setup allows you to run the entire Balancer v3 Backend locally, which would have helped debug the infinite recursion logging issue faster.

## Quick Start

1.  **Setup**:

    ```bash
    ./docker-dev.sh setup
    ```

2.  **Add your API keys** to `.env` file:

        ```bash
        # Edit .env and add your actual API keys
        RPC_URL_TEMPLATE=https://rpc.ankr.com/${network}/${apiKey}

    RPC_API_KEY=your-actual-key
    THEGRAPH_API_KEY_FANTOM=your-actual-key
    THEGRAPH_API_KEY_BALANCER=your-actual-key

    ```

    ```

3.  **Start services**:

    ```bash
    # For quick API testing (recommended)
    ./docker-dev.sh api

    # Or start all services
    ./docker-dev.sh start
    ```

4.  **Run migrations**:

    ```bash
    ./docker-dev.sh migrate
    ```

5.  **Test the API**:
    ```bash
    curl http://localhost:4000/health
    ```

## Available Services

### Production-like Setup (`docker-compose.yml`)

-   **API** (port 4000) - Main GraphQL API
-   **Worker** - Background job processor
-   **Scheduler** - Cron jobs and scheduled tasks
-   **PostgreSQL** (port 5431) - Database
-   **Redis** (port 6379) - Caching

### Development Setup (`docker-compose.yml`)

-   **API** (port 4000) - Hot reload enabled
-   **PostgreSQL** (port 5431) - Database only

## Commands

```bash
# Helper script commands
./docker-dev.sh setup     # Initial setup
./docker-dev.sh start     # Start all services
./docker-dev.sh api       # Start only API + database
./docker-dev.sh stop      # Stop all services
./docker-dev.sh logs      # Show logs
./docker-dev.sh shell     # Shell access to API container
./docker-dev.sh db        # Connect to database
./docker-dev.sh migrate   # Run Prisma migrations
./docker-dev.sh status    # Show service status

# Direct Docker Compose commands
docker compose up -d                    # Start all services
docker compose -f docker-compose.yml up -d  # Development mode
docker compose logs -f api              # Follow API logs
docker compose exec api bash            # Shell access
docker compose exec postgres psql -U backend -d database  # Database access
```

## Debugging Benefits

This setup would have caught the logging infinite recursion issue because:

1. **Same container environment** as production
2. **Easy log access** with `./docker-dev.sh logs-api`
3. **Quick iteration** - fix code and restart container
4. **Isolated environment** - no conflicts with local Node.js setup
5. **Memory monitoring** - Docker stats show memory usage spikes

## Environment Variables

The containers use the same environment variables as production, with sensible defaults for local development. Key variables:

-   `WORKER=true/false` - Determines which service mode to run
-   `SCHEDULER=true/false` - Enables scheduled jobs
-   `DATABASE_URL` - PostgreSQL connection string
-   `DEFAULT_CHAIN_ID` - Blockchain network (250 = Fantom)

## Volumes

-   **Source code**: Mounted for hot reload in development
-   **PostgreSQL data**: Persisted in Docker volume
-   **node_modules**: Excluded from mounting to avoid conflicts

## Health Checks

All services have health checks:

-   **API**: HTTP check on `/health` endpoint
-   **Database**: PostgreSQL ready check
-   **Redis**: Ping check

## Troubleshooting

**Container won't start**:

```bash
./docker-dev.sh logs-api  # Check logs
./docker-dev.sh shell     # Debug inside container
```

**Database connection issues**:

```bash
./docker-dev.sh db        # Test database access
./docker-dev.sh migrate   # Ensure migrations ran
```

**Memory issues**:

```bash
docker stats              # Monitor resource usage
```

**Port conflicts**:

-   API: 4000
-   PostgreSQL: 5431 (not 5432 to avoid conflicts)
-   Redis: 6379

## Production Simulation

To test production-like behavior:

1. Use `docker-compose.yml` (not dev version)
2. Build with production Dockerfile
3. Set `NODE_ENV=production`
4. Test all three services (API, Worker, Scheduler)

This Docker setup provides a much faster feedback loop for debugging infrastructure and deployment issues locally.
