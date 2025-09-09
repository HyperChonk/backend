import { Chain } from '@prisma/client';
import { env } from '../apps/env';
import { NetworkData } from '../modules/network/network-config-types';

export default <NetworkData>{
    chain: {
        slug: 'berachain',
        id: 80094,
        nativeAssetAddress: '0x0000000000000000000000000000000000000000',
        wrappedNativeAssetAddress: '0x6969696969696969696969696969696969696969', // WBERA
        prismaId: Chain.BERACHAIN,
        gqlId: 'BERACHAIN' as any,
    },
    subgraphs: {
        startDate: '2024-01-25', // Today's date as requested
        balancer: 'https://api.goldsky.com/api/public/project_cluukfpdrw61a01xag6yihcuy/subgraphs/berachain/prod/gn',
        balancerV3:
            'https://api.goldsky.com/api/public/project_cluukfpdrw61a01xag6yihcuy/subgraphs/berachain-v3-vault/0.0.5/gn',
        balancerPoolsV3:
            'https://api.goldsky.com/api/public/project_cluukfpdrw61a01xag6yihcuy/subgraphs/berachain-v3-pools/0.0.2/gn',
        cowAmm: '', // Not available on BERACHAIN
        beetsBar: '', // Not available on BERACHAIN
    },
    hooks: {
        // No hooks configured yet for BERACHAIN
    },
    eth: {
        address: '0x0000000000000000000000000000000000000000',
        addressFormatted: '0x0000000000000000000000000000000000000000',
        symbol: 'BERA',
        name: 'Bera',
    },
    weth: {
        address: '0x6969696969696969696969696969696969696969', // WBERA
        addressFormatted: '0x6969696969696969696969696969696969696969',
    },
    coingecko: {
        nativeAssetId: 'berachain-bera',
        platformId: 'berachain',
        excludedTokenAddresses: [],
    },
    rpcUrl: 'https://lb.drpc.org/berachain/Anc4m43-Eki8iVxy0KG4yYNN0SBHfaQR8I2pIgaNGuYu', // Default RPC URL - may need to be updated
    // rpcUrl: env.RPC_API_KEY
    //     ? env.RPC_URL_TEMPLATE.replace('${network}', 'berachain').replace('${apiKey}', env.RPC_API_KEY)
    //     : 'https://rpc.berachain.com/', // Default RPC URL - may need to be updated
    rpcMaxBlockRange: 400,
    acceptableSGLag: 30, // ~1min
    protocolToken: 'bal',
    bal: {
        address: '0x28e0e3b9817012b356119df9e217c25932d609c2', // Will need to be filled when BAL is deployed on Berachain
    },
    balancer: {
        v2: {
            vaultAddress: '0xBE09E71BDc7b8a50A05F7291920590505e3C7744',
            defaultSwapFeePercentage: '0.5',
            defaultYieldFeePercentage: '0.5',
            balancerQueriesAddress: '0x48205280899D45838dD01124C017C972A0E11Cd3',
        },
        v3: {
            vaultAddress: '0x637aB87781AcB95A5674b2158Ed4a0c9De9945eA',
            routerAddress: '0xac9CA9d4b803533890A95566EB8788643A0FCe26',
            defaultSwapFeePercentage: '0.5',
            defaultYieldFeePercentage: '0.5',
        },
    },
    multicall: '',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11', // Standard multicall3 address
    avgBlockSpeed: 2,
    ybAprConfig: {
        dolomite: {
            apiUrl: 'https://api.dolomite.io/tokens/80094/interest-rates',
            tokens: {
                WBERA: {
                    address: '0x6969696969696969696969696969696969696969',
                    isIbYield: true,
                    wrappedTokens: {
                        dWBERA: '0xaa97d791afc02af30cf0b046172bb05b3c306517',
                    },
                },
                NECT: {
                    address: '0x1ce0a25d13ce4d52071ae7e02cf1f6606f4c79d3',
                    isIbYield: true,
                    wrappedTokens: {
                        dNECT: '0x474f32eb1754827c531c16330db07531e901bcbe',
                    },
                },
                // Add more tokens as needed
            },
        },
    },
    monitoring: {
        main: {
            alarmTopicArn: '',
        },
        canary: {
            alarmTopicArn: '',
        },
    },
};
