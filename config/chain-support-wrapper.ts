import { Chain } from '@prisma/client';

/**
 * Supported chains that have real subgraph endpoints
 * ONLY MODIFY THIS LIST to control which chains are supported
 */
export const SUPPORTED_CHAINS: Chain[] = [
    // 'MAINNET',
    // 'ARBITRUM',
    'POLYGON',
    'HYPEREVM',
    'BERACHAIN',
    // 'OPTIMISM',
    // 'BASE',
    // 'AVALANCHE',
    // 'GNOSIS',
    // Add/remove chains here as needed
] as const;

/**
 * Check if a chain is supported (has real subgraph endpoints)
 * This is the MAIN function to control chain support at runtime
 */
export function isChainSupported(chain: Chain): boolean {
    return SUPPORTED_CHAINS.includes(chain);
}

/**
 * Check if a chain is unsupported (should use mock data)
 */
export function isChainUnsupported(chain: Chain): boolean {
    return !isChainSupported(chain);
}
