# 🚀 Local Development Environment

This guide walks you through setting up the complete Balancer v3 Backend infrastructure locally using Docker and LocalStack, mirroring the AWS production environment.

## 📋 Prerequisites

-   **Docker Desktop** (v4.0+) with Docker Compose
-   **Bun** (v1.0+) - for package management and development
-   **Git** - for version control
-   **Node.js** (v18+) - for tooling (optional if using Docker exclusively)

## 🏗️ Architecture Overview

The local environment replicates the AWS infrastructure with these services:

| Service           | Production (AWS) | Local (Docker + LocalStack) |
| ----------------- | ---------------- | --------------------------- |
| **API**           | ECS Fargate      | Docker Container            |
| **Worker**        | ECS Fargate      | Docker Container            |
| **Scheduler**     | ECS Fargate      | Docker Container            |
| **Database**      | RDS PostgreSQL   | PostgreSQL Container        |
| **Queues**        | SQS              | LocalStack SQS              |
| **Storage**       | S3               | LocalStack S3               |
| **Secrets**       | Secrets Manager  | LocalStack Secrets Manager  |
| **Logs**          | CloudWatch       | LocalStack CloudWatch       |
| **Parameters**    | Systems Manager  | LocalStack SSM              |
| **Notifications** | SNS              | LocalStack SNS              |

## 🚀 Quick Start

### 1. Clone and Set Up Environment

```bash
# Clone the repository
git clone <repository-url>
cd balancer-v3-backend

# Copy environment template and configure
cp env-template.txt .env
# Edit .env with your API keys (see Environment Variables section)
```

### 2. Start All Services

```bash
# Start the complete local environment
./scripts/start-local.sh

# Or manually with Docker Compose
docker compose up -d
```

The startup script will:

-   🔧 Start PostgreSQL and Redis
-   🌩️ Initialize LocalStack with AWS resources
-   🚀 Start API, Worker, and Scheduler services
-   🗄️ Run database migrations
-   🏥 Check service health

### 3. Verify Everything is Running

```bash
# Check service status
./scripts/start-local.sh status

# Test the API
curl http://localhost:4000/health
curl http://localhost:4000/graphql -X POST -H "Content-Type: application/json" -d '{"query": "{ __schema { queryType { name } } }"}'
```

## 🔧 Environment Variables

### Required API Keys

For full functionality, add these to your `.env` file:

```bash
# Essential for blockchain data
RPC_URL_TEMPLATE=https://rpc.ankr.com/${network}/${apiKey}
RPC_API_KEY=your_rpc_provider_key_here
THEGRAPH_API_KEY_BALANCER=your_thegraph_key_here
THEGRAPH_API_KEY_FANTOM=your_thegraph_key_here

# Optional but recommended
COINGECKO_API_KEY=your_coingecko_key_here
SENTRY_DSN=your_sentry_dsn_here
```

### Where to Get API Keys

| Service          | URL                              | Purpose               |
| ---------------- | -------------------------------- | --------------------- |
| **RPC Provider** | https://ankr.com/ (or others)    | Blockchain RPC access |
| **The Graph**    | https://thegraph.com/studio/     | Subgraph data         |
| **CoinGecko**    | https://www.coingecko.com/en/api | Price data            |
| **Sentry**       | https://sentry.io/               | Error tracking        |

## 📊 Available Endpoints

Once running, these endpoints are available:

| Service          | URL                           | Purpose                                       |
| ---------------- | ----------------------------- | --------------------------------------------- |
| **GraphQL API**  | http://localhost:4000/graphql | Main API endpoint                             |
| **Health Check** | http://localhost:4000/health  | Service health status                         |
| **PostgreSQL**   | localhost:5432                | Database (user: `backend`, pass: `let-me-in`) |
| **Redis**        | localhost:6379                | Cache                                         |
| **LocalStack**   | http://localhost:4566         | AWS services                                  |

## 🔧 Development Commands

### Service Management

```bash
# Start all services
./scripts/start-local.sh

# Stop all services
./scripts/start-local.sh stop

# Clean everything (including volumes)
./scripts/start-local.sh clean

# Restart services
./scripts/start-local.sh restart

# View logs
./scripts/start-local.sh logs [service_name]
```

### Database Operations

```bash
# Run migrations
docker compose exec api bun prisma db push

# Reset database
docker compose exec api bun prisma db push --force-reset

# View database
docker compose exec api bun prisma studio
```

### Development Workflow

```bash
# Install dependencies
bun install

# Generate Prisma client
bun prisma generate

# Build the application
bun run build

# Run tests
bun test

# Development mode (hot reload)
bun run dev
```

## 🌩️ LocalStack AWS Services

LocalStack provides local versions of AWS services:

### Created Resources

-   **SQS Queues**: 3 queues + 1 DLQ for job processing
-   **S3 Buckets**: 4 buckets for artifacts, logs, backups, assets
-   **CloudWatch**: Log groups for each service
-   **Secrets Manager**: Configuration secrets
-   **Systems Manager**: Parameters for service communication
-   **SNS**: Topics for notifications

### Accessing LocalStack

```bash
# List SQS queues
docker compose exec localstack awslocal sqs list-queues

# List S3 buckets
docker compose exec localstack awslocal s3 ls

# View CloudWatch log groups
docker compose exec localstack awslocal logs describe-log-groups
```

## 🐛 Troubleshooting

### Common Issues

**Services not starting:**

```bash
# Check Docker is running
docker --version

# Check service logs
docker compose logs [service_name]

# Clean and restart
./scripts/start-local.sh clean
./scripts/start-local.sh
```

**Database connection issues:**

```bash
# Check PostgreSQL is healthy
docker compose exec postgres pg_isready -U backend -d database

# Reset database
docker compose down -v
docker compose up -d postgres
```

**LocalStack AWS services not working:**

```bash
# Check LocalStack health
curl http://localhost:4566/_localstack/health

# Reinitialize AWS resources
docker compose restart localstack
```

**API not responding:**

```bash
# Check API health
curl http://localhost:4000/health

# Check API logs
docker compose logs api

# Rebuild API container
docker compose build api
docker compose up -d api
```

### Useful Debugging Commands

```bash
# Exec into containers
docker compose exec api bash
docker compose exec postgres psql -U backend -d database

# View container resource usage
docker stats

# Clean Docker system
docker system prune -a
```

## 🔍 Service Configuration

### Service Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│      API        │    │     Worker      │    │   Scheduler     │
│  (Port 4000)    │    │ (Background)    │    │ (Background)    │
│                 │    │                 │    │                 │
│ • GraphQL       │    │ • SQS Consumer  │    │ • SQS Producer  │
│ • REST Health   │    │ • Job Processor │    │ • Cron Jobs     │
│ • HTTP Server   │    │ • No HTTP       │    │ • No HTTP       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────┐
                    │   PostgreSQL    │
                    │  (Port 5432)    │
                    │                 │
                    │ • Main Database │
                    │ • Prisma ORM    │
                    └─────────────────┘
```

### Environment Variables

Each service uses the same environment variables but with different flags:

-   **API**: `WORKER=false, SCHEDULER=false`
-   **Worker**: `WORKER=true, SCHEDULER=false`
-   **Scheduler**: `WORKER=false, SCHEDULER=true`

## 📚 Additional Resources

-   [AWS Infrastructure Documentation](./infrastructure/README.md)
-   [API Documentation](./docs/API.md)
-   [Deployment Guide](./infrastructure/DEPLOYMENT.md)
-   [Contributing Guidelines](./CONTRIBUTING.md)

## 🆘 Getting Help

If you encounter issues:

1. Check this troubleshooting guide
2. Review service logs: `./scripts/start-local.sh logs`
3. Clean and restart: `./scripts/start-local.sh clean && ./scripts/start-local.sh`
4. Open an issue with logs and error details

---

**Happy coding! 🚀**
