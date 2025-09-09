module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/test/unit/**/*.test.ts', '**/test/config/**/*.test.ts', '**/test/security/**/*.test.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
  collectCoverageFrom: [
    'lib/**/*.ts',
    'config/**/*.ts',
    '!**/*.d.ts',
    '!**/*.test.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70
    }
  },
  setupFilesAfterEnv: ['<rootDir>/test/helpers/test-setup.ts'],
  testTimeout: 30000
}; 
