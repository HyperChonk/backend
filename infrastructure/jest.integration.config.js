module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/test/integration/**/*.test.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
  testTimeout: 180000, // 3 minutes for integration tests with LocalStack startup
  setupFilesAfterEnv: ['<rootDir>/test/helpers/localstack-setup.ts'],
  maxWorkers: 1, // Run integration tests sequentially to avoid conflicts
  detectOpenHandles: true,
  forceExit: true
}; 
