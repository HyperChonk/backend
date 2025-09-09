import { execSync } from 'child_process';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import axios from 'axios';

// LocalStack configuration
export const localstackConfig = {
    endpoint: 'http://127.0.0.1:4566',
    region: 'us-east-1',
    accessKeyId: 'test',
    secretAccessKey: 'test',
};

// AWS clients configured for LocalStack
export const localstackClients = {
    secretsManager: new SecretsManagerClient({
        endpoint: localstackConfig.endpoint,
        region: localstackConfig.region,
        credentials: {
            accessKeyId: localstackConfig.accessKeyId,
            secretAccessKey: localstackConfig.secretAccessKey,
        },
    }),
    cloudFormation: new CloudFormationClient({
        endpoint: localstackConfig.endpoint,
        region: localstackConfig.region,
        credentials: {
            accessKeyId: localstackConfig.accessKeyId,
            secretAccessKey: localstackConfig.secretAccessKey,
        },
    }),
};

/**
 * Check if LocalStack is running
 */
export async function isLocalStackRunning(): Promise<boolean> {
    try {
        const response = await axios.get(`${localstackConfig.endpoint}/_localstack/health`, {
            timeout: 5000,
            validateStatus: (status) => status === 200,
        });

        if (response.status === 200 && response.data) {
            const health = response.data;

            // Check if core services are available or running
            const requiredServices = ['s3', 'secretsmanager', 'cloudformation'];
            const allServicesReady = requiredServices.every((service) => {
                const serviceStatus = health.services?.[service];
                return serviceStatus === 'available' || serviceStatus === 'running';
            });

            return allServicesReady;
        }
        return false;
    } catch (error) {
        return false;
    }
}

/**
 * Wait for LocalStack to be ready
 */
export async function waitForLocalStack(timeoutMs: number = 90000): Promise<void> {
    const startTime = Date.now();
    let lastError: string = '';
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 10; // Allow some temporary failures

    console.log(`⏳ Waiting for LocalStack to be ready (timeout: ${timeoutMs}ms)...`);

    while (Date.now() - startTime < timeoutMs) {
        try {
            if (await isLocalStackRunning()) {
                // Additional wait for services to be fully ready
                console.log('⏳ Services detected, waiting 3s for full initialization...');
                await new Promise((resolve) => setTimeout(resolve, 3000));
                console.log('✅ LocalStack services are ready!');
                return;
            }
            consecutiveFailures = 0; // Reset on successful check
        } catch (error) {
            consecutiveFailures++;
            lastError = error instanceof Error ? error.message : String(error);

            // If we have too many consecutive failures, something is seriously wrong
            if (consecutiveFailures >= maxConsecutiveFailures) {
                throw new Error(`Too many consecutive health check failures: ${lastError}`);
            }
        }

        const elapsed = Date.now() - startTime;
        if (elapsed % 10000 < 2000) {
            // Log every 10 seconds
            console.log(`⏳ Still waiting... (${Math.round(elapsed / 1000)}s elapsed)`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(`LocalStack not ready after ${timeoutMs}ms. Last error: ${lastError}`);
}

/**
 * Start LocalStack using Docker Compose
 */
export async function startLocalStack(): Promise<void> {
    try {
        console.log('🚀 Starting LocalStack...');

        // Check if docker compose file exists
        const composeFile = 'test/docker-compose.localstack.yml';
        try {
            execSync(`ls ${composeFile}`, { stdio: 'pipe', cwd: process.cwd() });
        } catch {
            throw new Error(`Docker compose file not found: ${composeFile}`);
        }

        // Start LocalStack
        execSync(`docker compose -f ${composeFile} up -d`, {
            stdio: 'inherit',
            cwd: process.cwd(),
        });

        await waitForLocalStack(90000); // 90 second timeout for startup
        console.log('✅ LocalStack is ready!');
    } catch (error) {
        console.error('❌ Failed to start LocalStack:', error);
        throw error;
    }
}

/**
 * Stop LocalStack
 */
export async function stopLocalStack(): Promise<void> {
    try {
        console.log('🛑 Stopping LocalStack...');
        execSync('docker compose -f test/docker-compose.localstack.yml down', {
            stdio: 'pipe',
            cwd: process.cwd(),
        });
        console.log('✅ LocalStack stopped');
    } catch (error) {
        console.error('❌ Failed to stop LocalStack:', error);
        // Don't throw - cleanup should be best effort
    }
}

/**
 * Clean up LocalStack resources
 */
export async function cleanupLocalStack(): Promise<void> {
    try {
        // Clean up any test resources
        execSync('docker compose -f test/docker-compose.localstack.yml down -v', {
            stdio: 'pipe',
            cwd: process.cwd(),
        });
    } catch (error) {
        console.error('❌ Failed to cleanup LocalStack:', error);
    }
}

// Track if setup has been completed to avoid duplicate runs
let setupCompleted = false;
let setupPromise: Promise<void> | null = null;

/**
 * Ensure LocalStack is ready for tests
 */
export async function ensureLocalStackReady(): Promise<void> {
    // If setup is already completed, return immediately
    if (setupCompleted) {
        console.log('✅ LocalStack setup already completed, skipping...');
        return;
    }

    // If setup is in progress, wait for it to complete
    if (setupPromise) {
        console.log('⏳ LocalStack setup in progress, waiting...');
        return setupPromise;
    }

    // Start setup and store the promise
    setupPromise = (async () => {
        try {
            console.log('🔍 Checking LocalStack status...');
            const isRunning = await isLocalStackRunning();

            if (isRunning) {
                console.log('✅ LocalStack is already running and ready!');
                setupCompleted = true;
                setupPromise = null; // Clear the promise
                return;
            }

            console.log('🚀 LocalStack not running, starting it...');
            await startLocalStack();
            setupCompleted = true;
            setupPromise = null; // Clear the promise
        } catch (error) {
            console.error('❌ Failed to ensure LocalStack is ready:', error);
            setupCompleted = false;
            setupPromise = null;
            throw error;
        }
    })();

    return setupPromise;
}

// Global setup and teardown for Jest
beforeAll(async () => {
    await ensureLocalStackReady();
}, 120000); // 2 minute timeout for setup

afterAll(async () => {
    // Leave LocalStack running for faster subsequent test runs
    console.log('💡 Leaving LocalStack running for faster subsequent tests');
    // await stopLocalStack();
});
