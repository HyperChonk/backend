import { TokenPriceHandler } from '../../token-types';
import { PrismaTokenWithTypes } from '../../../../prisma/prisma-types';
import { timestampRoundedUpToNearestHour } from '../../../common/time';
import { prisma } from '../../../../prisma/prisma-client';
import _ from 'lodash';
import { tokenAndPrice, updatePrices } from './price-handler-helper';
import { Chain } from '@prisma/client';
import fantom from '../../../../config/fantom';

export class FbeetsPriceHandlerService implements TokenPriceHandler {
    public readonly exitIfFails = false;
    public readonly id = 'FbeetsPriceHandlerService';

    private getAcceptedTokens(tokens: PrismaTokenWithTypes[]): PrismaTokenWithTypes[] {
        const fbeetsAddress = fantom.fbeets!.address;
        return tokens.filter((token) => token.chain === 'FANTOM' && token.address === fbeetsAddress);
    }

    public async updatePricesForTokens(
        tokens: PrismaTokenWithTypes[],
        chains: Chain[],
    ): Promise<PrismaTokenWithTypes[]> {
        const fbeetsAddress = fantom.fbeets!.address;
        const fbeetsPoolId = fantom.fbeets!.poolId;
        const acceptedTokens = this.getAcceptedTokens(tokens);
        const tokenAndPrices: tokenAndPrice[] = [];

        const timestamp = timestampRoundedUpToNearestHour();
        const fbeets = await prisma.prismaFbeets.findFirst({});
        const pool = await prisma.prismaPool.findUnique({
            where: { id_chain: { id: fbeetsPoolId, chain: 'FANTOM' } },
            include: { dynamicData: true, tokens: { include: { token: true } } },
        });

        if (!fbeets) {
            throw new Error('FbeetsPriceHandlerService: Could not find fbeets configuration in database');
        }

        if (!pool) {
            throw new Error(`FbeetsPriceHandlerService: Could not find pool with ID ${fbeetsPoolId} on FANTOM chain`);
        }

        if (!pool.dynamicData) {
            throw new Error(`FbeetsPriceHandlerService: Pool ${fbeetsPoolId} is missing dynamic data`);
        }

        const tokenPrices = await prisma.prismaTokenCurrentPrice.findMany({
            where: { tokenAddress: { in: pool.tokens.map((token) => token.address) }, chain: 'FANTOM' },
        });

        if (tokenPrices.length !== pool.tokens.length) {
            const missingPrices = pool.tokens.filter(
                (token) => !tokenPrices.find((price) => price.tokenAddress === token.address)
            );
            throw new Error(`FbeetsPriceHandlerService: Missing price data for tokens: ${missingPrices.map(t => t.address).join(', ')}`);
        }

        const fbeetsPrice = _.sum(
            pool.tokens.map((token) => {
                const totalShares = parseFloat(pool.dynamicData?.totalShares || '0');
                const balance = parseFloat(token.balance || '0');
                const tokenPrice = tokenPrices.find((price) => price.tokenAddress === token.address)?.price || 0;

                if (totalShares === 0) {
                    return 0;
                }

                return (balance / totalShares) * parseFloat(fbeets.ratio) * tokenPrice;
            }),
        );

        tokenAndPrices.push({
            address: fbeetsAddress,
            chain: 'FANTOM',
            price: fbeetsPrice,
        });

        await updatePrices(this.id, tokenAndPrices, timestamp);

        return acceptedTokens;
    }
}
