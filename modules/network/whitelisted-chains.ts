import { env } from '../../apps/env';
import { chainToChainId } from './chain-id-to-chain';

// Parse the comma-separated string from the environment variable
const whitelistedChainIds = (env.WHITELISTED_CHAINS || '').split(',').filter((id: string) => id.trim() !== '');

// Use only explicitly whitelisted chains - no fallback to prevent accidents
const activeChains = whitelistedChainIds;

// Add warning if no chains are whitelisted
if (activeChains.length === 0) {
    console.warn(
        '⚠️  WHITELISTED_CHAINS is empty - no chains will be active! This will prevent all chain-specific operations.',
    );
    console.warn('   Make sure WHITELISTED_CHAINS environment variable is properly set.');
}

/**
 * Returns an array of chain IDs that are whitelisted for the current environment.
 */
export function getWhitelistedChains(): string[] {
    return activeChains;
}

/**
 * Checks if a given chain ID or name is in the environment's whitelist.
 * @param chain The chain ID or name to check.
 * @returns True if the chain is whitelisted, false otherwise.
 */
export function isChainWhitelisted(chain: string): boolean {
    // make sure we are checking against the chainId
    const chainId = isNaN(Number(chain)) ? chainToChainId[chain] : chain;
    return activeChains.includes(chainId);
}
