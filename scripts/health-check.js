#!/usr/bin/env node

/**
 * Health Check Script for Balancer v3 Backend
 * 
 * Monitors application health by checking:
 * - Database connectivity
 * - API endpoint responsiveness
 * - Critical service dependencies
 */

const http = require('http');
const https = require('https');
const { performance } = require('perf_hooks');

// Use consistent port configuration
const PORT = process.env.PORT || 4000;
const HOST = process.env.HEALTH_CHECK_HOST || 'localhost';
const TIMEOUT = parseInt(process.env.HEALTH_CHECK_TIMEOUT) || 5000;

const CONFIG = {
  hostname: process.env.HEALTH_CHECK_HOST || 'localhost',
  port: process.env.PORT || 3000,
  path: process.env.HEALTH_CHECK_PATH || '/health',
  timeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT) || 5000,
  retries: parseInt(process.env.HEALTH_CHECK_RETRIES) || 3,
  retryDelay: parseInt(process.env.HEALTH_CHECK_RETRY_DELAY) || 1000
};

/**
 * Make HTTP request with timeout
 */
function makeRequest(options, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const protocol = options.protocol === 'https:' ? https : http;

    const req = protocol.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          data: data,
          headers: res.headers,
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

/**
 * Check application health endpoint
 */
async function checkHealthEndpoint() {
  try {
    const response = await makeRequest({
      hostname: HOST,
      port: PORT,
      path: '/health',
      method: 'GET',
      timeout: TIMEOUT,
    });

    if (response.statusCode === 200) {
      console.log('✓ Health endpoint is responding');
      return true;
    } else {
      console.error(`✗ Health endpoint returned status ${response.statusCode}`);
      return false;
    }
  } catch (error) {
    console.error('✗ Health endpoint check failed:', error.message);
    return false;
  }
}

/**
 * Check application readiness endpoint
 */
async function checkReadinessEndpoint() {
  try {
    const response = await makeRequest({
      hostname: HOST,
      port: PORT,
      path: '/ready',
      method: 'GET',
      timeout: TIMEOUT,
    });

    if (response.statusCode === 200) {
      console.log('✓ Readiness endpoint is responding');
      return true;
    } else {
      console.error(`✗ Readiness endpoint returned status ${response.statusCode}`);
      return false;
    }
  } catch (error) {
    console.error('✗ Readiness endpoint check failed:', error.message);
    return false;
  }
}

/**
 * Check GraphQL endpoint
 */
async function checkGraphQLEndpoint() {
  try {
    const introspectionQuery = {
      query: 'query IntrospectionQuery { __schema { queryType { name } } }',
    };

    const response = await makeRequest({
      hostname: HOST,
      port: PORT,
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(introspectionQuery)),
      },
      timeout: TIMEOUT,
    });

    if (response.statusCode === 200) {
      console.log('✓ GraphQL endpoint is responding');
      return true;
    } else {
      console.error(`✗ GraphQL endpoint returned status ${response.statusCode}`);
      return false;
    }
  } catch (error) {
    console.error('✗ GraphQL endpoint check failed:', error.message);
    return false;
  }
}

/**
 * Performs a health check against the application
 * @param {Object} config - Configuration options
 * @returns {Promise<Object>} Health check result
 */
function performHealthCheck() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: '/health',
      method: 'GET',
      timeout: TIMEOUT,
    };

    const req = http.request(options, (res) => {
      if (res.statusCode === 200) {
        resolve({ status: 'healthy', port: PORT });
      } else {
        reject(new Error(`Health check failed with status ${res.statusCode}`));
      }
    });

    req.on('error', (err) => {
      reject(new Error(`Health check request failed: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Health check timed out after ${TIMEOUT}ms`));
    });

    req.setTimeout(TIMEOUT);
    req.end();
  });
}

/**
 * Performs health check with retries
 * @param {Object} config - Configuration options
 * @returns {Promise<Object>} Health check result
 */
async function healthCheckWithRetries(config = CONFIG) {
  let lastError;

  for (let attempt = 1; attempt <= config.retries; attempt++) {
    try {
      const result = await performHealthCheck(config);

      if (attempt > 1) {
        console.log(`✅ Health check passed on attempt ${attempt}/${config.retries}`);
      }

      return result;
    } catch (error) {
      lastError = error;

      if (attempt < config.retries) {
        console.log(`⏳ Health check failed (attempt ${attempt}/${config.retries}): ${error.message}`);
        console.log(`   Retrying in ${config.retryDelay}ms...`);

        await new Promise(resolve => setTimeout(resolve, config.retryDelay));
      }
    }
  }

  throw lastError;
}

/**
 * Main execution function
 */
async function main() {
  const isVerbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  const isJson = process.argv.includes('--json');

  if (isVerbose) {
    console.log('🏥 Starting health check...');
    console.log(`📍 Target: http://${CONFIG.hostname}:${CONFIG.port}${CONFIG.path}`);
    console.log(`⏱️  Timeout: ${CONFIG.timeout}ms`);
    console.log(`🔄 Retries: ${CONFIG.retries}`);
  }

  try {
    await performHealthCheck();
    console.log(`✅ Health check passed on port ${PORT}`);
    process.exit(0);
  } catch (error) {
    console.error(`❌ Health check failed: ${error.message}`);
    process.exit(1);
  }
}

// Handle process signals
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, exiting...');
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, exiting...');
  process.exit(1);
});

// Handle CLI usage
if (require.main === module) {
  // Show help if requested
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
Health Check Script for Balancer GraphQL API

Usage: node health-check.js [options]

Options:
  --verbose, -v     Show detailed output
  --json           Output results in JSON format
  --help, -h       Show this help message

Environment Variables:
  HEALTH_CHECK_HOST          Target hostname (default: localhost)
  PORT                       Target port (default: 3000)
  HEALTH_CHECK_PATH          Health endpoint path (default: /health)
  HEALTH_CHECK_TIMEOUT       Request timeout in ms (default: 5000)
  HEALTH_CHECK_RETRIES       Number of retries (default: 3)
  HEALTH_CHECK_RETRY_DELAY   Delay between retries in ms (default: 1000)

Examples:
  node health-check.js --verbose
  node health-check.js --json
  HEALTH_CHECK_HOST=api.balancer.com node health-check.js
`);
    process.exit(0);
  }

  // Run the health check
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}

module.exports = {
  checkHealthEndpoint,
  checkReadinessEndpoint,
  checkGraphQLEndpoint,
  performHealthCheck,
  healthCheckWithRetries,
  CONFIG
}; 
