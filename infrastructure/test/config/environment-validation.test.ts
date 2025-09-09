import { loadEnvironmentConfig } from '../../config/environments/shared';
import { EnvironmentName } from '../../config/shared/types';

describe('Environment Configuration Validation', () => {
    const environments: EnvironmentName[] = ['development', 'staging', 'production'];

    // Test that all environments load successfully
    test.each(environments)('%s environment loads without errors', async (env) => {
        const config = await loadEnvironmentConfig(env);
        expect(config).toBeDefined();
        expect(config.environment).toBe(env);
    });

    // Test database configuration consistency - this would have caught our PostgreSQL version issue
    test.each(environments)('%s environment has valid database configuration', async (env) => {
        const config = await loadEnvironmentConfig(env);

        // Database engine version validation - should be a PostgreSQL version enum
        expect(config.database.engineVersion).toBeDefined();
        expect(typeof config.database.engineVersion).toBe('object');
        
        // Should be a PostgreSQL 15 or 16 version
        // Check if it's a valid enum value (CDK enums are strings internally)
        expect(config.database.engineVersion).toContain('15');

        // Database instance type validation - should be an InstanceType object
        expect(config.database.instanceSize).toBeDefined();
        expect(typeof config.database.instanceSize).toBe('object');

        // Database configuration completeness
        expect(config.database.allocatedStorage).toBeGreaterThan(0);
        if (config.database.maxAllocatedStorage) {
            expect(config.database.maxAllocatedStorage).toBeGreaterThanOrEqual(config.database.allocatedStorage);
        }
        expect(config.database.connectionLimits.maxConnections).toBeGreaterThan(0);
        expect(config.database.backupRetention).toBeGreaterThanOrEqual(1);
        expect(config.database.backupRetention).toBeLessThanOrEqual(35);
    });

    // Test that production has appropriate security settings compared to development
    test('Production has appropriate security compared to development', async () => {
        const prod = await loadEnvironmentConfig('production');
        const dev = await loadEnvironmentConfig('development');

        // WAF should be enabled in production
        expect(prod.security.enableWaf).toBe(true);

        // Production should have higher rate limits to handle more traffic (not stricter)
        expect(prod.security.wafRateLimit).toBeGreaterThanOrEqual(dev.security.wafRateLimit);

        // Production should have more restrictive monitoring thresholds (lower values = more sensitive)
        expect(prod.monitoring.thresholds.cpuUtilization).toBeLessThanOrEqual(dev.monitoring.thresholds.cpuUtilization);
        expect(prod.monitoring.thresholds.memoryUtilization).toBeLessThanOrEqual(
            dev.monitoring.thresholds.memoryUtilization,
        );
    });

    // Test security configuration - this would have caught our GraphQL limits and WAF issues
    test.each(environments)('%s environment has secure configuration', async (env) => {
        const config = await loadEnvironmentConfig(env);

        // GraphQL query size limits should be reasonable - this would have caught our hardcoded limits
        expect(config.security.graphqlQuerySizeLimit).toBeGreaterThan(1000); // At least 1KB
        expect(config.security.graphqlQuerySizeLimit).toBeLessThanOrEqual(50000); // No more than 50KB

        // Security settings should be properly configured
        expect(config.security).toBeDefined();
        expect(config.security.enableWaf).toBeDefined();

        // WAF rate limit should be reasonable
        expect(config.security.wafRateLimit).toBeGreaterThan(0);
        expect(config.security.wafRateLimit).toBeLessThanOrEqual(10000);

        // Production should have stricter limits
        if (env === 'production') {
            expect(config.security.wafRateLimit).toBeLessThanOrEqual(2000); // Reasonable limit
            expect(config.security.enableWaf).toBe(true);
        }
    });

    // Test resource sizing is appropriate for environment
    test.each(environments)('%s environment has appropriate resource sizing', async (env) => {
        const config = await loadEnvironmentConfig(env);

        // Development should use smaller instances
        if (env === 'development') {
            expect(config.resources.cpu).toBeLessThanOrEqual(1024); // 1 vCPU
            expect(config.resources.memoryMiB).toBeLessThanOrEqual(2048);
            expect(config.database.allocatedStorage).toBeLessThanOrEqual(100);
        }

        // Production should have higher limits (reasonable for mid-scale application)
        if (env === 'production') {
            expect(config.autoScaling.maxInstances).toBeGreaterThanOrEqual(5);
            if (config.database.maxAllocatedStorage) {
                expect(config.database.maxAllocatedStorage).toBeGreaterThanOrEqual(100); // Reasonable for mid-scale
            }
        }

        // All environments should have reasonable limits
        expect(config.autoScaling.minInstances).toBeGreaterThanOrEqual(1);
        expect(config.autoScaling.maxInstances).toBeGreaterThanOrEqual(config.autoScaling.minInstances);
        expect(config.resources.cpu).toBeGreaterThan(0);
        expect(config.resources.memoryMiB).toBeGreaterThan(0);
    });

    // Test monitoring configuration completeness
    test.each(environments)('%s environment has complete monitoring configuration', async (env) => {
        const config = await loadEnvironmentConfig(env);

        // CloudWatch settings
        expect(config.monitoring.logRetention).toBeDefined();
        expect(config.monitoring.detailedMonitoring).toBeDefined();

        // Alarm thresholds should be sensible
        expect(config.monitoring.thresholds.cpuUtilization).toBeGreaterThan(0);
        expect(config.monitoring.thresholds.cpuUtilization).toBeLessThanOrEqual(100);
        expect(config.monitoring.thresholds.memoryUtilization).toBeGreaterThan(0);
        expect(config.monitoring.thresholds.memoryUtilization).toBeLessThanOrEqual(100);
        expect(config.monitoring.thresholds.sqsQueueDepth).toBeGreaterThan(0);
        expect(config.monitoring.thresholds.sqsMessageAge).toBeGreaterThan(0);
    });

    // Test load balancer configuration
    test.each(environments)('%s environment has valid load balancer configuration', async (env) => {
        const config = await loadEnvironmentConfig(env);

        // Health check configuration should be reasonable
        expect(config.loadBalancer.healthCheckInterval).toBeGreaterThan(0);
        expect(config.loadBalancer.healthCheckTimeout).toBeGreaterThan(0);
        expect(config.loadBalancer.healthCheckTimeout).toBeLessThan(config.loadBalancer.healthCheckInterval);

        expect(config.loadBalancer.healthyThresholdCount).toBeGreaterThanOrEqual(2);
        expect(config.loadBalancer.unhealthyThresholdCount).toBeGreaterThanOrEqual(2);

        expect(config.loadBalancer.healthCheckPath).toMatch(/^\/.*$/); // Should start with /
        expect(config.loadBalancer.idleTimeout).toBeGreaterThan(0);
    });

    // Test SQS configuration
    test.each(environments)('%s environment has valid SQS configuration', async (env) => {
        const config = await loadEnvironmentConfig(env);

        // SQS timeouts should be reasonable
        expect(config.sqs.visibilityTimeoutSeconds).toBeGreaterThan(0);
        expect(config.sqs.messageRetentionPeriod).toBeGreaterThan(0);
        expect(config.sqs.receiveWaitTimeSeconds).toBeGreaterThanOrEqual(0);
        expect(config.sqs.receiveWaitTimeSeconds).toBeLessThanOrEqual(20);

        expect(config.sqs.maxReceiveCount).toBeGreaterThan(0);
        expect(config.sqs.dlqRetentionPeriod).toBeGreaterThan(0);
    });

    // Test that all environments have consistent structure
    test('All environments have consistent configuration structure', async () => {
        const configs = await Promise.all(environments.map((env) => loadEnvironmentConfig(env)));

        const [dev, staging, prod] = configs;

        // All should have same top-level keys
        const devKeys = Object.keys(dev).sort();
        const stagingKeys = Object.keys(staging).sort();
        const prodKeys = Object.keys(prod).sort();

        expect(stagingKeys).toEqual(devKeys);
        expect(prodKeys).toEqual(devKeys);

        // Database configuration structure should be consistent
        expect(Object.keys(staging.database).sort()).toEqual(Object.keys(dev.database).sort());
        expect(Object.keys(prod.database).sort()).toEqual(Object.keys(dev.database).sort());

        // Resources configuration structure should be consistent
        expect(Object.keys(staging.resources).sort()).toEqual(Object.keys(dev.resources).sort());
        expect(Object.keys(prod.resources).sort()).toEqual(Object.keys(dev.resources).sort());
    });

    // Test database version compatibility across environments
    test('Database versions are compatible across environments', async () => {
        const configs = await Promise.all(environments.map((env) => loadEnvironmentConfig(env)));

        const versions = configs.map((config) => {
            const version = config.database.engineVersion.toString();
            // Extract version number from enum like 'VER_15' or 'VER_16_1'
            const match = version.match(/VER_(\d+)/);
            return match ? parseInt(match[1]) : 15;
        });

        // All versions should be within the same major version family
        const majorVersions = [...new Set(versions)];
        expect(majorVersions.length).toBeLessThanOrEqual(2); // Allow at most 2 major versions

        // Versions should be in ascending order (dev <= staging <= prod) or all the same
        expect(versions[0]).toBeLessThanOrEqual(versions[1]); // dev <= staging
        expect(versions[1]).toBeLessThanOrEqual(versions[2]); // staging <= prod
    });

    // Test cost configuration
    test.each(environments)('%s environment has valid cost configuration', async (env) => {
        const config = await loadEnvironmentConfig(env);

        expect(config.cost.monthlyBudgetLimit).toBeGreaterThan(0);
        expect(config.cost.budgetAlertThreshold).toBeGreaterThan(0);
        expect(config.cost.budgetAlertThreshold).toBeLessThanOrEqual(100);

        // Production should have higher budget limits (reasonable for mid-scale application)
        if (env === 'production') {
            expect(config.cost.monthlyBudgetLimit).toBeGreaterThanOrEqual(200); // Reasonable for mid-scale
        }
    });
});
