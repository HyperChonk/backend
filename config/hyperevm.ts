import { Chain } from '@prisma/client';
import { NetworkData } from '../modules/network/network-config-types';

/**
 * @TODO: Fill out after HyperEVM mainnet deployment
 */
const config: NetworkData = {
    chain: {
        slug: 'hyperevm',
        id: 999,
        nativeAssetAddress: '0x2222222222222222222222222222222222222222',
        wrappedNativeAssetAddress: '0x5555555555555555555555555555555555555555',
        prismaId: Chain.HYPEREVM,
        gqlId: 'HYPEREVM' as any,
    },
    // alchemy does not yet support hyperevm
    // rpcUrl: env.RPC_API_KEY
    //     ? env.RPC_URL_TEMPLATE.replace('${network}', 'hyperevm').replace('${apiKey}', env.RPC_API_KEY)
    //     : process.env.HYPEREVM_RPC_URL || 'https://rpc.hyperliquid.xyz/evm',
    rpcUrl: 'https://rpc.hyperliquid.xyz/evm',
    rpcMaxBlockRange: 999,
    acceptableSGLag: 120,
    subgraphs: {
        startDate: '2025-06-24',
        // balancer: `${process.env.API_BASE_URL || 'http://localhost:4000'}/graphql/v2_mock`,
        balancer: '',
        balancerV3:
            'https://api.goldsky.com/api/public/project_cluukfpdrw61a01xag6yihcuy/subgraphs/hyperevm-v3-vault/beta/gn',
        balancerPoolsV3:
            'https://api.goldsky.com/api/public/project_cluukfpdrw61a01xag6yihcuy/subgraphs/hyperevm-v3-pools/0.0.3/gn',
        cowAmm: '', // Not available on HYPEREVM
        beetsBar: '', // Not available on HYPEREVM
    },
    hooks: {
        // No hooks configured yet for HYPEREVM
    },
    coingecko: {
        nativeAssetId: 'hyperevm',
        platformId: 'hyperevm',
        excludedTokenAddresses: [],
    },
    eth: {
        address: '0x2222222222222222222222222222222222222222',
        addressFormatted: '0x2222222222222222222222222222222222222222',
        symbol: 'HYPE',
        name: 'HyperLiquid',
    },
    weth: {
        address: '0x5555555555555555555555555555555555555555',
        addressFormatted: '0x5555555555555555555555555555555555555555',
    },
    protocolToken: 'bal',
    bal: {
        address: '',
    },
    balancer: {
        v2: {
            vaultAddress: '',
            defaultSwapFeePercentage: '',
            defaultYieldFeePercentage: '',
            balancerQueriesAddress: '',
        },
        v3: {
            vaultAddress: '0xbc198EBF1eBDdE1209716B149b11713CC7F40B83',
            routerAddress: '0x695302D7f68A62F1421F75E622EF1D1969373eB3',
            defaultSwapFeePercentage: '0.5',
            defaultYieldFeePercentage: '0.5',
        },
    },
    multicall: '',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    avgBlockSpeed: 2,
    ybAprConfig: {},
    monitoring: {
        canary: {
            alarmTopicArn: '',
        },
        main: {
            alarmTopicArn: '',
        },
    },
};

export default config;
