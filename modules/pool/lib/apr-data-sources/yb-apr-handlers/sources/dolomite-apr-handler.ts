import axios from 'axios';
import { AprHandler } from '../types';

export class DolomiteAprHandler implements AprHandler {
    tokens: {
        [assetName: string]: {
            address: string;
            isIbYield?: boolean;
            wrappedTokens: {
                [tokenName: string]: string;
            };
        };
    };
    apiUrl: string;
    group = 'DOLOMITE';

    constructor(aprHandlerConfig: {
        apiUrl: string;
        tokens: {
            [assetName: string]: {
                address: string;
                isIbYield?: boolean;
                wrappedTokens: {
                    [tokenName: string]: string;
                };
            };
        };
    }) {
        this.tokens = aprHandlerConfig.tokens;
        this.apiUrl = aprHandlerConfig.apiUrl;
    }

    async getAprs() {
        try {
            const { data } = await axios.get(this.apiUrl);
            const { interestRates } = data as DolomiteResponse;

            const aprsByAddress = Object.fromEntries(
                interestRates.map((rate) => [
                    rate.token.tokenAddress.toLowerCase(),
                    parseFloat(rate.totalSupplyInterestRate),
                ]),
            );

            const aprEntries = Object.values(this.tokens)
                .map(({ address, isIbYield, wrappedTokens }) => {
                    const apr = aprsByAddress[address.toLowerCase()];
                    if (!apr) return null;

                    return Object.values(wrappedTokens).map((wrappedTokenAddress) => ({
                        [wrappedTokenAddress]: {
                            apr,
                            isIbYield: isIbYield ?? true,
                            group: this.group,
                        },
                    }));
                })
                .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
                .flat()
                .reduce((acc, curr) => ({ ...acc, ...curr }), {});

            return aprEntries;
        } catch (e) {
            console.error(`Failed to fetch Dolomite APR from ${this.apiUrl}:`, e);
            return {};
        }
    }
}

interface DolomiteResponse {
    interestRates: Array<{
        token: {
            tokenAddress: string;
            marketId: string;
            tokenSymbol: string;
            tokenName: string;
        };
        supplyInterestRate: string;
        totalSupplyInterestRate: string;
        // ... other fields we don't need
    }>;
}
