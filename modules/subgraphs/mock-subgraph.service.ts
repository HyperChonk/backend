/**
 * Mock subgraph service that returns empty but valid responses
 * Used for unsupported chains to maintain interface compatibility
 */
export class MockSubgraphService {
    private baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    async query(query: string, variables?: any): Promise<any> {
        // Return empty but valid GraphQL response structure
        return {
            data: this.getEmptyResponseForQuery(query),
            errors: null,
        };
    }

    private getEmptyResponseForQuery(query: string): any {
        // Parse the query to determine what empty structure to return
        if (query.includes('pools')) {
            return { pools: [] };
        }
        if (query.includes('swaps')) {
            return { swaps: [] };
        }
        if (query.includes('poolSnapshots')) {
            return { poolSnapshots: [] };
        }
        if (query.includes('joinExits')) {
            return { joinExits: [] };
        }
        if (query.includes('balances')) {
            return { balances: [] };
        }
        if (query.includes('tokens')) {
            return { tokens: [] };
        }
        if (query.includes('meta')) {
            return {
                meta: {
                    block: { number: '0' },
                    deployment: 'mock',
                    hasIndexingErrors: false,
                },
            };
        }

        // Default empty response
        return {};
    }
}

/**
 * Creates a mock GraphQL endpoint URL for unsupported chains
 */
export function createMockSubgraphUrl(chain: string, subgraphType: string): string {
    return `mock://localhost/subgraph/${chain}/${subgraphType}`;
}

/**
 * Check if a URL is a mock subgraph URL
 */
export function isMockSubgraphUrl(url: string): boolean {
    return url.startsWith('mock://');
}

/**
 * Helper for controllers: returns empty array for unsupported chains,
 * or continues with provided function for supported chains
 */
export function handleUnsupportedChain<T>(
    chain: import('@prisma/client').Chain,
    supportedChainFunction: () => Promise<T[]> | T[],
): Promise<T[]> | T[] {
    const { isChainUnsupported } = require('../../config/chain-support-wrapper');

    if (isChainUnsupported(chain)) {
        return []; // Return empty array for unsupported chains
    }

    return supportedChainFunction();
}

/**
 * Helper for controllers: returns true if chain is unsupported
 * Use this instead of throwing errors in controllers
 */
export function isUnsupportedChain(chain: import('@prisma/client').Chain): boolean {
    const { isChainUnsupported } = require('../../config/chain-support-wrapper');
    return isChainUnsupported(chain);
}
