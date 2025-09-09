import { LoadCodegenConfigResult } from '@graphql-codegen/cli';
import config from './config';
import { env } from './apps/env';

// Parse whitelisted chains from environment (same logic as whitelisted-chains.ts)
const whitelistedChainIds = (env.WHITELISTED_CHAINS || '').split(',').filter((id: string) => id.trim() !== '');

// Chain ID mapping for schema generation
const CHAIN_SCHEMA_MAPPING = {
    '1': 'MAINNET', // Mainnet
    '250': 'FANTOM', // Fantom
    '42161': 'ARBITRUM', // Arbitrum
    '137': 'POLYGON', // Polygon
    '10': 'OPTIMISM', // Optimism
    '8453': 'BASE', // Base
    '100': 'GNOSIS', // Gnosis
    '43114': 'AVALANCHE', // Avalanche
    '1101': 'ZKEVM', // zkEVM (corrected from 324)
    '11155111': 'SEPOLIA', // Sepolia Testnet
    '252': 'FRAXTAL', // Fraxtal
    '34443': 'MODE', // Mode
    '146': 'SONIC', // Sonic (corrected from 64165)
    '999': 'HYPEREVM', // HyperEVM
    '998': 'HYPEREVM_TESTNET', // HyperEVM Testnet
    '80094': 'BERACHAIN', // Berachain
} as const;

// Helper function to check if a chain should generate schemas
function shouldGenerateForChain(chainKey: keyof typeof config): boolean {
    if (whitelistedChainIds.length === 0) {
        throw new Error('⚠️  No chains whitelisted. Please set the WHITELISTED_CHAINS environment variable.');
    }

    // Find if this chain config corresponds to any whitelisted chain ID
    const chainId = Object.entries(CHAIN_SCHEMA_MAPPING).find(([_, configKey]) => configKey === chainKey)?.[0];
    const isWhitelisted = chainId ? whitelistedChainIds.includes(chainId) : false;

    if (!isWhitelisted) {
        console.log(
            `⏭️  Skipping schema generation for ${chainKey} (not in WHITELISTED_CHAINS: ${whitelistedChainIds.join(
                ',',
            )})`,
        );
    }

    return isWhitelisted;
}

const plugins = {
    types: ['typescript', 'typescript-operations', 'typescript-graphql-request'],
    schema: ['schema-ast'],
};

const defaults = {
    types: {
        plugins: plugins.types,
        config: {
            scalars: {
                BigInt: 'string',
                Bytes: 'string',
                BigDecimal: 'string',
            },
        },
    },
};

// Build files object dynamically based on whitelisted chains
const files: Record<string, any> = {};

// Only generate schemas for whitelisted chains
if (shouldGenerateForChain('MAINNET')) {
    files['modules/sources/subgraphs/cow-amm/generated/types.ts'] = {
        schema: config.MAINNET.subgraphs.cowAmm,
        documents: 'modules/sources/subgraphs/cow-amm/*.graphql',
        ...defaults.types,
    };

    files['modules/sources/subgraphs/balancer-v3-vault/generated/types.ts'] = {
        schema: config.MAINNET.subgraphs.balancerV3,
        documents: 'modules/sources/subgraphs/balancer-v3-vault/*.graphql',
        ...defaults.types,
    };

    files['modules/sources/subgraphs/balancer-v3-pools/generated/types.ts'] = {
        schema: config.MAINNET.subgraphs.balancerPoolsV3,
        documents: 'modules/sources/subgraphs/balancer-v3-pools/*.graphql',
        ...defaults.types,
    };

    files['modules/subgraphs/balancer-subgraph/generated/balancer-subgraph-types.ts'] = {
        schema: config.MAINNET.subgraphs.balancer,
        documents: 'modules/subgraphs/balancer-subgraph/balancer-subgraph-queries.graphql',
        ...defaults.types,
    };

    files['modules/subgraphs/gauge-subgraph/generated/gauge-subgraph-types.ts'] = {
        schema: config.MAINNET.subgraphs.gauge,
        documents: 'modules/subgraphs/gauge-subgraph/gauge-subgraph-queries.graphql',
        ...defaults.types,
        config: {
            ...defaults.types.config,
            namingConvention: {
                enumValues: 'keep',
            },
        },
    };

    files['modules/subgraphs/veBal-locks-subgraph/generated/veBal-locks-subgraph-types.ts'] = {
        schema: config.MAINNET.subgraphs.gauge,
        documents: 'modules/subgraphs/veBal-locks-subgraph/veBal-locks-subgraph-queries.graphql',
        ...defaults.types,
        config: {
            ...defaults.types.config,
            namingConvention: {
                enumValues: 'keep',
            },
        },
    };

    files['modules/sources/subgraphs/aura/generated/aura-subgraph-types.ts'] = {
        schema: config.MAINNET.subgraphs.aura,
        documents: 'modules/sources/subgraphs/aura/aura-subgraph-queries.graphql',
        ...defaults.types,
        config: {
            ...defaults.types.config,
            namingConvention: {
                enumValues: 'keep',
            },
        },
    };
}

if (shouldGenerateForChain('FANTOM')) {
    files['modules/subgraphs/masterchef-subgraph/generated/masterchef-subgraph-types.ts'] = {
        schema: config.FANTOM.subgraphs.masterchef,
        documents: 'modules/subgraphs/masterchef-subgraph/masterchef-subgraph-queries.graphql',
        ...defaults.types,
    };

    files['modules/subgraphs/reliquary-subgraph/generated/reliquary-subgraph-types.ts'] = {
        schema: config.FANTOM.subgraphs.reliquary,
        documents: 'modules/subgraphs/reliquary-subgraph/reliquary-subgraph-queries.graphql',
        ...defaults.types,
        config: {
            ...defaults.types.config,
            namingConvention: {
                enumValues: 'keep',
            },
        },
    };

    files['modules/sources/subgraphs/sftmx-subgraph/generated/sftmx-subgraph-types.ts'] = {
        schema: config.FANTOM.subgraphs.sftmx,
        documents: 'modules/sources/subgraphs/sftmx-subgraph/sftmx-subgraph-queries.graphql',
        ...defaults.types,
        config: {
            ...defaults.types.config,
            namingConvention: {
                enumValues: 'keep',
            },
        },
    };

    files['modules/subgraphs/beets-bar-subgraph/generated/beets-bar-subgraph-types.ts'] = {
        schema: config.FANTOM.subgraphs.beetsBar,
        documents: 'modules/subgraphs/beets-bar-subgraph/beets-bar-subgraph-queries.graphql',
        ...defaults.types,
    };
}

if (shouldGenerateForChain('SONIC')) {
    files['modules/sources/subgraphs/sts-subgraph/generated/sts-subgraph-types.ts'] = {
        schema: config.SONIC.subgraphs.sts,
        documents: 'modules/sources/subgraphs/sts-subgraph/sts-subgraph-queries.graphql',
        ...defaults.types,
        config: {
            ...defaults.types.config,
            namingConvention: {
                enumValues: 'keep',
            },
        },
    };
}

// Always generate API schemas (not chain-specific)
files['apps/api/gql/generated-schema-ast.ts'] = {
    schema: './apps/api/gql/schema/*.gql',
    plugins: [
        {
            add: {
                content:
                    "import { gql } from 'graphql-request';\nexport const schema = gql`\n#\n# THIS FILE IS AUTOGENERATED — DO NOT EDIT IT\n#\n",
            },
        },
        'schema-ast',
        { add: { content: '`;', placement: 'append' } },
    ],
};

files['apps/api/gql/generated-schema.ts'] = {
    schema: './apps/api/gql/schema/*.gql',
    plugins: [
        {
            add: {
                content: '/*\n * THIS FILE IS AUTOGENERATED — DO NOT EDIT IT\n */',
            },
        },
        'typescript',
        'typescript-resolvers',
    ],
    config: {
        declarationKind: 'interface',
        immutableTypes: false,
        useIndexSignature: true,
        enumsAsTypes: true,
        contextType: './resolver-context#ResolverContext',
        scalars: {
            Date: 'Date',
            UUID: 'string',
            GqlBigNumber: 'string',
            Bytes: 'string',
            BigDecimal: 'string',
            BigInt: 'string',
            AmountHumanReadable: 'string',
        },
    },
};

// Log what's being generated
console.log(`🔧 GraphQL Code Generation:`);
console.log(`   WHITELISTED_CHAINS: ${whitelistedChainIds.join(',') || 'none'}`);
console.log(`   Generating ${Object.keys(files).length} schema files`);
Object.keys(files).forEach((file) => console.log(`   📄 ${file}`));

export default {
    overwrite: true,
    hooks: {
        afterAllFileWrite: ['prettier --write'],
    },
    generates: files,
} as LoadCodegenConfigResult['config'];
