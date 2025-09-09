import { defineChain } from 'viem';

export const hyperevm = /*#__PURE__*/ defineChain({
    id: 999,
    name: 'Hyper EVM',
    nativeCurrency: {
        name: 'HYPE',
        symbol: 'HYPE',
        decimals: 18,
    },
    rpcUrls: {
        default: {
            http: ['https://rpc.hyperliquid.xyz/evm'],
        },
    },
    blockExplorers: {
        default: {
            name: 'HyperEVM Explorer',
            url: 'https://www.hyperscan.com/',
        },
    },
    contracts: {
        multicall3: {
            address: '0xcA11bde05977b3631167028862bE2a173976CA11',
            blockCreated: 13051,
        },
    },
    testnet: false,
});

export const hyperevmTestnet = /*#__PURE__*/ defineChain({
    id: 998,
    name: 'Hyper EVM Testnet',
    nativeCurrency: {
        name: 'HYPE',
        symbol: 'HYPE',
        decimals: 18,
    },
    rpcUrls: {
        default: {
            http: ['https://rpc.hyperliquid-testnet.xyz/evm'],
        },
    },
    blockExplorers: {
        default: {
            name: 'HyperEVM Testnet Explorer',
            url: 'https://testnet.purrsec.com/',
        },
    },
    contracts: {
        multicall3: {
            address: '0xcA11bde05977b3631167028862bE2a173976CA11',
            blockCreated: 16237117,
        },
    },
    testnet: true,
});
