import { prisma } from '../../../prisma/prisma-client';
import { chainIdToChain } from '../../network/chain-id-to-chain';

const TAGS_URL = 'https://raw.githubusercontent.com/hyperchonk/v3-metadata/refs/heads/main/pools/tags/index.json';

type TagItem = {
    id: string;
    pools: string[];
    tokens: { [chainId: string]: string[] };
};

export const getPoolMetadataTags = async (
    existingTags: Record<string, Set<string>>,
): Promise<Record<string, Set<string>>> => {
    const response = await fetch(TAGS_URL);
    const tagsList = (await response.json()) as TagItem[];

    for (const tag of tagsList) {
        if (tag.pools) {
            tag.pools.forEach((poolId) => {
                poolId = poolId.toLowerCase();
                if (!existingTags[poolId]) {
                    existingTags[poolId] = new Set();
                }
                existingTags[poolId].add(tag.id.toUpperCase());
                if (tag.id.toLowerCase().startsWith('points_')) {
                    existingTags[poolId].add(`POINTS`);
                }
            });
        }

        if (tag.tokens) {
            for (const chainId in tag.tokens) {
                for (const tokenAddress of tag.tokens[chainId]) {
                    const chain = chainIdToChain[chainId];
                    const poolsWithToken = await prisma.prismaPool.findMany({
                        where: { chain: chain, allTokens: { some: { tokenAddress: tokenAddress.toLowerCase() } } },
                    });
                    poolsWithToken.forEach((pool) => {
                        if (!existingTags[pool.id]) {
                            existingTags[pool.id] = new Set();
                        }
                        existingTags[pool.id].add(tag.id.toUpperCase());
                        if (tag.id.toLowerCase().startsWith('points_')) {
                            existingTags[pool.id].add(`POINTS`);
                        }
                    });
                }
            }
        }
    }

    return existingTags;
};
