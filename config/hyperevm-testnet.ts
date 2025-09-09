import { Chain } from '@prisma/client';
import { env } from '../apps/env';
import { NetworkData } from '../modules/network/network-config-types';

const config: NetworkData = {
    chain: {
        slug: 'hyperevm-testnet',
        id: 998,
        nativeAssetAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        wrappedNativeAssetAddress: '0x5555555555555555555555555555555555555555',
        prismaId: Chain.HYPEREVM_TESTNET,
        gqlId: 'HYPEREVM_TESTNET' as any,
    },
    rpcUrl: env.RPC_API_KEY
        ? env.RPC_URL_TEMPLATE.replace('${network}', 'hyperevm-testnet').replace('${apiKey}', env.RPC_API_KEY)
        : process.env.HYPEREVM_TESTNET_RPC_URL || 'https://rpc.hyperliquid-testnet.xyz/evm',
    rpcMaxBlockRange: 1000,
    acceptableSGLag: 120,
    subgraphs: {
        startDate: '',
        balancer: process.env.HYPEREVM_TESTNET_SUBGRAPH_URL || '',
        gauge: process.env.HYPEREVM_TESTNET_GAUGE_SUBGRAPH_URL || '',
    },
    coingecko: {
        nativeAssetId: 'hyperliquid-testnet',
        platformId: 'hyperliquid-testnet',
        excludedTokenAddresses: [],
    },
    eth: {
        address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        addressFormatted: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        symbol: 'HYPE',
        name: 'HyperLiquid',
    },
    weth: {
        address: '0x5555555555555555555555555555555555555555',
        addressFormatted: '0x5555555555555555555555555555555555555555',
    },
    protocolToken: 'bal',
    bal: {
        address: '0x58A501c3Cc724aB1Ac9184452C16E158d5122d48',
    },
    balancer: {
        v2: {
            vaultAddress: '',
            defaultSwapFeePercentage: '',
            defaultYieldFeePercentage: '',
            balancerQueriesAddress: '',
        },
        v3: {
            vaultAddress: '0xe029cE4721D3fF51a26a7Ce4aAafdF2Ad2CCa5d5',
            routerAddress: '0x7dBE80Ef0519cA07489bb2d11Be0867C1785D83A',
            defaultSwapFeePercentage: '0.5',
            defaultYieldFeePercentage: '0.1',
        },
    },
    multicall: '0x5ba1e12693dc8f9c48aad8770482f4739beed696',
    multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
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
