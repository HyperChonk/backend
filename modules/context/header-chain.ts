import { Chain } from '@prisma/client';
import { getRequestScopeContextValue } from '../context/request-scoped-context';
import { chainIdToChain, chainToChainId } from '../network/chain-id-to-chain';

/**
 * Setup to transition out from the old header-based chainIDs to the new required chain query filters.
 *
 * @returns The chain of the current request, if any.
 */
export const headerChain = (): Chain | undefined => {
    const chainId = getRequestScopeContextValue<string>('chainId');

    if (chainId) {
        const chainIdNum = isNaN(Number(chainId)) ? chainToChainId[chainId] : Number(chainId);
        return chainIdToChain[chainIdNum];
    }

    return undefined;
};
