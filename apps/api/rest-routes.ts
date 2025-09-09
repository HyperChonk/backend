import { Express } from 'express';
import { prisma } from '../../prisma/prisma-client';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
    beetsGetCirculatingSupply,
    beetsGetCirculatingSupplySonic,
    beetsGetTotalSupplySonic,
} from '../../modules/beets/lib/beets';

function getBuildInfo() {
    return {
        version: process.env.BUILD_VERSION || '0.0.0',
        gitCommit: {
            hash: process.env.BUILD_GIT_HASH || 'unknown',
            shortHash: process.env.BUILD_GIT_SHORT_HASH || 'unknown',
        },
        buildTime: process.env.BUILD_TIME || 'unknown',
        nodeVersion: process.version,
    };
}

function getDeploymentInfo() {
    return {
        deployedAt: process.env.DEPLOYMENT_TIME || new Date().toISOString(),
    };
}

function normalizeEnvironment(env: string): string {
    if (env === 'dev' || env === 'development') return 'development';
    if (env === 'stage' || env === 'staging') return 'staging';
    if (env === 'prod' || env === 'production') return 'production';
    return 'development';
}

async function getInfrastructureInfo(): Promise<object> {
    try {
        const rawEnv = process.env.DEPLOYMENT_ENV || process.env.NODE_ENV || 'development';
        const environment = normalizeEnvironment(rawEnv);
        const region = process.env.AWS_REGION || 'us-east-1';
        const parameterName = `/v3-backend/${environment}/infrastructure/version`;

        const ssmClient = new SSMClient({ region });
        const response = await ssmClient.send(
            new GetParameterCommand({
                Name: parameterName,
            }),
        );

        if (response.Parameter?.Value) {
            const infrastructureInfo = JSON.parse(response.Parameter.Value);
            return {
                version: infrastructureInfo.version,
                gitCommit: infrastructureInfo.gitCommit,
                deployedAt: infrastructureInfo.deployedAt,
            };
        }
    } catch (error) {
        // Don't fail health check if infrastructure version is not available
        console.warn(
            'Could not retrieve infrastructure version:',
            error instanceof Error ? error.message : 'Unknown error',
        );
    }

    // Return fallback info if SSM parameter is not available
    return {
        version: 'unknown',
        gitCommit: {
            hash: 'unknown',
            shortHash: 'unknown',
        },
        deployedAt: 'unknown',
    };
}

export function loadRestRoutes(app: Express) {
    // TEMPORARY: Debug health check that always returns 200 OK
    app.use('/health-check-debug', (req, res) => {
        res.status(200).json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            message: 'Debug health check - always healthy',
        });
    });

    app.use('/health', async (req, res) => {
        try {
            // A true health check must validate critical dependencies.
            // The database is the most critical one.
            await prisma.$queryRaw`SELECT 1`;

            // Get infrastructure version info
            const infrastructureInfo = await getInfrastructureInfo();

            const healthInfo = {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                database: 'connected',
                environment: process.env.NODE_ENV,
                build: getBuildInfo(),
                deployment: getDeploymentInfo(),
                infrastructure: infrastructureInfo,
            };

            res.status(200).json(healthInfo);
        } catch (error) {
            console.error('Health check failed:', error);
            res.status(503).json({
                status: 'unhealthy',
                timestamp: new Date().toISOString(),
                error: 'Database connection failed',
                environment: process.env.NODE_ENV,
                details: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    });

    app.use('/ready', async (req, res) => {
        try {
            // More comprehensive readiness check
            await prisma.$queryRaw`SELECT 1`;
            res.status(200).json({ status: 'ready' });
        } catch (error) {
            res.status(503).json({
                status: 'not ready',
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    });

    app.use('/circulating_supply', (_, res) => {
        beetsGetCirculatingSupply().then((result) => {
            res.send(result);
        });
    });
    app.use('/circulating_supply_sonic', (_, res) => {
        beetsGetCirculatingSupplySonic().then((result) => {
            res.send(result);
        });
    });
    app.use('/total_supply_sonic', (_, res) => {
        beetsGetTotalSupplySonic().then((result) => {
            res.send(result);
        });
    });
}
