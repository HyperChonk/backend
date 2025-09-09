import { EnvType, load } from 'ts-dotenv';
import { resolve } from 'path';

type Env = EnvType<typeof schema>;

export const schema = {
    PORT: Number,
    NODE_ENV: String,
    DEFAULT_CHAIN_ID: String,
    DEPLOYMENT_ENV: String,
    ADMIN_API_KEY: String,
    SANITY_API_TOKEN: String,
    SENTRY_DSN: String,
    SENTRY_AUTH_TOKEN: String,
    SENTRY_TRACES_SAMPLE_RATE: {
        optional: true,
        type: String,
    },
    SENTRY_PROFILES_SAMPLE_RATE: {
        optional: true,
        type: String,
    },
    AWS_REGION: String,

    // AWS Configuration (for LocalStack and production)
    AWS_ACCESS_KEY_ID: {
        optional: true,
        type: String,
    },
    AWS_SECRET_ACCESS_KEY: {
        optional: true,
        type: String,
    },
    AWS_ENDPOINT_URL: {
        optional: true,
        type: String,
    },

    // Service Configuration Flags
    WORKER: {
        optional: true,
        type: String,
        default: 'false',
    },
    SCHEDULER: {
        optional: true,
        type: String,
        default: 'false',
    },
    AWS_ALERTS: {
        optional: true,
        type: String,
        default: 'false',
    },

    // SQS Configuration
    SQS_BACKGROUND_JOB_QUEUE_URL: {
        optional: true,
        type: String,
    },
    SQS_DATA_REFRESH_QUEUE_URL: {
        optional: true,
        type: String,
    },
    SQS_NOTIFICATION_QUEUE_URL: {
        optional: true,
        type: String,
    },

    // Logging Configuration
    LOG_LEVEL: {
        optional: true,
        type: String,
        default: 'info',
    },

    PROTOCOL: {
        optional: true,
        type: String,
    },
    RPC_URL_TEMPLATE: {
        optional: true,
        type: String,
        default: 'https://rpc.ankr.com/${network}/${apiKey}',
    },
    RPC_API_KEY: {
        optional: true,
        type: String,
    },
    COINGECKO_API_KEY: {
        optional: true,
        type: String,
    },
    THEGRAPH_API_KEY_FANTOM: {
        optional: true,
        type: String,
    },
    THEGRAPH_API_KEY_BALANCER: {
        optional: true,
        type: String,
    },

    WORKER_QUEUE_URL: {
        optional: true,
        type: String,
    },
    DATABASE_URL: String,
    WHITELISTED_CHAINS: {
        optional: true,
        type: String,
    },
};

// ✅ LAZY VALIDATION: Only validate when explicitly requested
// This allows CDK to import the schema without triggering validation
let _env: Env | null = null;

export const env: Env = new Proxy({} as Env, {
    get(target, prop) {
        // Lazy load and validate the environment on first access
        if (!_env) {
            _env = load(schema, {
                path: resolve(__dirname, `../../.env`),
                overrideProcessEnv: true,
            });
        }
        return _env[prop as keyof Env];
    },

    has(target, prop) {
        if (!_env) {
            _env = load(schema, {
                path: resolve(__dirname, `../../.env`),
                overrideProcessEnv: true,
            });
        }
        return prop in _env;
    },

    ownKeys(target) {
        if (!_env) {
            _env = load(schema, {
                path: resolve(__dirname, `../../.env`),
                overrideProcessEnv: true,
            });
        }
        return Object.keys(_env);
    },
});

// ✅ EXPORT SCHEMA FOR CDK: CDK can now safely import the schema without validation
export { schema as envSchema };
