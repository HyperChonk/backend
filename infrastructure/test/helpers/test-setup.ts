// Global test setup - runs before all tests

// Suppress CDK output during tests
process.env.CDK_CLI_VERSION = '2.0.0';
process.env.CDK_DISABLE_VERSION_CHECK = '1';

// Set consistent environment for tests
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCOUNT_ID = '123456789012'; // Mock account ID

// Export test utilities
export const testConfig = {
    region: 'us-east-1',
    accountId: '123456789012',
};
