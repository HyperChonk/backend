import { GraphQLClient, ClientError } from 'graphql-request';
// For TypeScript DOM lib typing in Node environments, we avoid using RequestInfo types directly

export async function fetchWithRetry(input: any, init?: any): Promise<Response> {
    const maxAttempts = 5;
    let attempt = 0;
    let lastError: any;

    while (attempt < maxAttempts) {
        try {
            const response = await fetch(input as any, init);
            if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
                attempt += 1;
                const retryAfter = parseInt(response.headers.get('retry-after') || '', 10);
                const backoff = !isNaN(retryAfter) ? retryAfter * 1000 : Math.min(500 * Math.pow(2, attempt - 1), 5000);
                await new Promise((r) => setTimeout(r, backoff));
                continue;
            }
            return response;
        } catch (err) {
            lastError = err;
            attempt += 1;
            const backoff = Math.min(500 * Math.pow(2, attempt - 1), 5000);
            await new Promise((r) => setTimeout(r, backoff));
        }
    }

    if (lastError) throw lastError;
    // Fallback to a generic error if none captured
    throw new Error('GraphQL fetch failed after retries');
}

export function createGraphQLClientWithRetry(url: string): GraphQLClient {
    return new GraphQLClient(url, {
        // No automatic retries; just ensure we convert thrown ClientErrors into safe logs higher up
        fetch: async (input: any, init?: any) => {
            try {
                return await fetch(input as any, init);
            } catch (err) {
                // Network errors still propagate; upstream callers should handle exceptions and log instead of crash
                throw err;
            }
        },
    } as any);
}

export async function subgraphLoadAll<T>(
    request: (variables: any) => Promise<any>,
    resultKey: string,
    args: any,
    maxPages = 5,
): Promise<T[]> {
    let all: any[] = [];
    const limit = 1000;
    let skip = 0;
    let hasMore = true;

    while (hasMore) {
        try {
            const response = await request({
                ...args,
                first: limit,
                skip,
            });

            all = [...all, ...response[resultKey]];
            skip += limit;
            hasMore = response[resultKey].length === limit;
        } catch (error: any) {
            const status = error?.response?.status;
            if (status === 429) {
                console.warn(
                    `Subgraph rate limited (429) on ${resultKey}. Query args: ${JSON.stringify(
                        args,
                    )}. Skipping remaining pages.`,
                );
                break;
            }
            console.warn(
                `Subgraph error on ${resultKey}. Query args: ${JSON.stringify(args)}. Skipping. Error: ${
                    error?.message || error
                }`,
            );
            break;
        }

        //TODO: rip this out asap
        if (maxPages > 0 && skip > maxPages * 1000) {
            console.log('BAILING EARLY FROM A subgraphLoadAll', resultKey, args);
            break;
        }
    }

    return all;
}
