import { Chain } from '@prisma/client';
import { createPublicClient, http, PublicClient } from 'viem';
import {
    arbitrum,
    avalanche,
    base,
    fantom,
    fraxtal,
    gnosis,
    mainnet,
    mode,
    optimism,
    polygon,
    polygonZkEvm,
    sepolia,
    sonic,
    berachain,
} from 'viem/chains';
import config from '../../config';
import { hyperevm, hyperevmTestnet } from './customChains';

export type ViemClient = ReturnType<typeof getViemClient>;

// Use this interface for easier mocking
export interface IViemClient {
    multicall: PublicClient['multicall'];
    readContract: PublicClient['readContract'];
}

const chain2ViemChain = {
    [Chain.MAINNET]: mainnet,
    [Chain.SEPOLIA]: sepolia,
    [Chain.ARBITRUM]: arbitrum,
    [Chain.AVALANCHE]: avalanche,
    [Chain.BASE]: base,
    [Chain.FANTOM]: fantom,
    [Chain.GNOSIS]: gnosis,
    [Chain.OPTIMISM]: optimism,
    [Chain.POLYGON]: polygon,
    [Chain.ZKEVM]: polygonZkEvm,
    [Chain.FRAXTAL]: fraxtal,
    [Chain.MODE]: mode,
    [Chain.SONIC]: sonic,
    [Chain.HYPEREVM]: hyperevm,
    [Chain.HYPEREVM_TESTNET]: hyperevmTestnet,
    [Chain.BERACHAIN]: berachain,
};

export const getViemClient = (chain: Chain) => {
    return createPublicClient({
        chain: chain2ViemChain[chain],
        transport: http(config[chain]?.rpcUrl, {
            timeout: 60_000,
            retryCount: 3,
            retryDelay: 500,
            onFetchRequest(request) {
                if (process.env.DEBUG) {
                    const reader = request.body?.getReader();
                    if (!reader) {
                        return;
                    }
                    let body = '';

                    reader
                        .read()
                        .then(function processText({ done, value }) {
                            if (done) {
                                return;
                            }
                            // value for fetch streams is a Uint8Array
                            body += value;
                            reader.read().then(processText);
                        })
                        .then(() => {
                            const json = JSON.parse(
                                body
                                    .split(',')
                                    .map((code) => String.fromCharCode(parseInt(code, 10)))
                                    .join(''),
                            );
                            try {
                                console.log(json['id'], json['method'], body.length, json['params'][0]['to']);
                            } catch (e) {
                                console.log(json['id'], json['method'], body.length);
                            }
                        });
                }
            },
        }),
    });
};
