import { prisma } from '../../../prisma/prisma-client';
import { HookData } from '../../../prisma/prisma-types';
import { chainIdToChain } from '../../network/chain-id-to-chain';

const TAGS_URL = 'https://raw.githubusercontent.com/hyperchonk/v3-metadata/refs/heads/main/hooks/index.json';

type HooksMetadata = {
    id: string;
    addresses: {
        [chainId: string]: string[];
    };
};

export const getPoolHookTags = async (
    existingTags: Record<string, Set<string>>,
): Promise<Record<string, Set<string>>> => {
    const response = await fetch(TAGS_URL);
    const hooksMetadataList = (await response.json()) as HooksMetadata[];

    // Get hook addresses from the database
    const poolsWithHooks = await prisma.prismaPool.findMany({
        where: { hook: { path: ['address'], string_starts_with: '0x' } },
    });

    for (const hookMetadata of hooksMetadataList) {
        for (const chainId in hookMetadata.addresses) {
            const addresses = hookMetadata.addresses[chainId].map((address) => address.toLowerCase());
            for (const pool of poolsWithHooks) {
                if (pool.chain === chainIdToChain[chainId] && addresses.includes((pool.hook as HookData).address)) {
                    if (!existingTags[pool.id]) {
                        existingTags[pool.id] = new Set();
                    }
                    existingTags[pool.id].add(`${hookMetadata.id.toUpperCase()}`);
                }
            }
        }
    }

    return existingTags;
};
