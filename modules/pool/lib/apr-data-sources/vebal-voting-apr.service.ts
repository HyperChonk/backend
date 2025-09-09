import { PoolAprService } from '../../pool-types';
import { PoolForAPRs } from '../../../../prisma/prisma-types';
import { Chain } from '@prisma/client';
import { prisma } from '../../../../prisma/prisma-client';

const HIDDEN_HAND_API_URL = 'https://api.hiddenhand.finance/proposal/balancer';
const VEBAL = '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56';

const vebalPool = '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014';
const id = `${vebalPool}-voting-apr`;
const chain = 'MAINNET';

type HiddenHandResponse = {
    error: boolean;
    data: {
        poolId: string;
        proposal: string;
        proposalHash: string;
        title: string;
        proposalDeadline: number;
        totalValue: number;
        maxTotalValue: number;
        voteCount: number;
        valuePerVote: number;
        maxValuePerVote: number;
        bribes: {
            token: string;
            symbol: string;
            decimals: number;
            value: number;
            maxValue: number;
            amount: number;
            maxTokensPerVote: number;
            briber: string;
            periodIndex: number;
            chainId: number;
        }[];
    }[];
};

const safeJsonParse = async (response: Response): Promise<HiddenHandResponse> => {
    try {
        if (!response.ok) {
            throw new Error(`[VeBalVotingAprService] HTTP ${response.status}: ${response.statusText}`);
        }

        const text = await response.text();
        if (!text || text.trim() === '') {
            throw new Error('Empty response body');
        }

        const data = JSON.parse(text) as HiddenHandResponse;

        // Validate response structure
        if (typeof data !== 'object' || data === null) {
            throw new Error('Invalid response: not an object');
        }

        if (data.error === true) {
            throw new Error(`API returned error: ${JSON.stringify(data)}`);
        }

        if (!Array.isArray(data.data)) {
            throw new Error('Invalid response: data is not an array');
        }

        return data;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`JSON Parse Error: ${error.message}`);
        }
        throw error;
    }
};

const fetchHiddenHandRound = async (
    timestamp?: number,
    retries = 3,
): Promise<{ total: number; votes: number; timestamp: number }> => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`🔄 Fetching Hidden Hand data (attempt ${attempt}/${retries})...`);

            const url = `${HIDDEN_HAND_API_URL}/${timestamp || ''}`;

            // Create AbortController for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'BalancerV3Backend/1.0',
                },
            });

            clearTimeout(timeoutId);

            const data = await safeJsonParse(response);

            if (!data.data || data.data.length === 0) {
                throw new Error('No proposal data returned');
            }

            // Get sum of all incentivized votes and total value
            const total = data.data.reduce((acc, proposal) => {
                return acc + (proposal.totalValue || 0);
            }, 0);

            const votes = data.data
                .filter((proposal) => (proposal.totalValue || 0) > 0)
                .reduce((acc, proposal) => acc + (proposal.voteCount || 0), 0);

            if (total === 0 || votes === 0) {
                throw new Error('No valid voting data found');
            }

            const result = {
                total,
                votes,
                timestamp: data.data[0]?.proposalDeadline || Math.floor(Date.now() / 1000),
            };

            console.log(`✅ Successfully fetched Hidden Hand data:`, result);
            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`❌ Hidden Hand fetch attempt ${attempt} failed:`, errorMessage);

            if (attempt === retries) {
                throw new Error(
                    `Failed to fetch Hidden Hand data after ${retries} attempts. Last error: ${errorMessage}`,
                );
            }

            // Wait before retry (exponential backoff)
            const waitTime = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
            console.log(`⏳ Waiting ${waitTime}ms before retry...`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
    }

    throw new Error('Unexpected error in fetchHiddenHandRound');
};

export const getHiddenHandAPR = async (timestamp: number): Promise<number> => {
    try {
        const round = await fetchHiddenHandRound(timestamp);

        console.log(`📊 Hidden Hand round data:`, {
            requestedTimestamp: timestamp,
            actualTimestamp: round.timestamp,
            totalValue: round.total,
            voteCount: round.votes,
        });

        timestamp = round.timestamp;

        if (round.votes === 0) {
            throw new Error('No votes found for the period');
        }

        const avgValuePerVote = round.total / round.votes;

        let veBalPrice;
        // When the timestamp is older than 24 hours, we can fetch the historical price
        if (timestamp < Math.ceil(+Date.now() / 1000) - 86400) {
            console.log(`🔍 Fetching historical veBAL price for timestamp: ${timestamp}`);
            veBalPrice = await prisma.prismaTokenPrice.findFirst({
                where: {
                    tokenAddress: VEBAL,
                    chain: Chain.MAINNET,
                    timestamp,
                },
            });
        }
        // Otherwise we fetch the current price
        else {
            console.log(`🔍 Fetching current veBAL price`);
            veBalPrice = await prisma.prismaTokenCurrentPrice.findFirst({
                where: {
                    tokenAddress: VEBAL,
                    chain: Chain.MAINNET,
                },
            });
        }

        if (!veBalPrice || !veBalPrice.price || veBalPrice.price <= 0) {
            throw new Error(`Failed to fetch valid veBAL price. Got: ${veBalPrice?.price}`);
        }

        const apr = (avgValuePerVote * 52) / veBalPrice.price;

        if (!Number.isFinite(apr) || apr < 0) {
            throw new Error(
                `Invalid APR calculated: ${apr}. avgValuePerVote: ${avgValuePerVote}, veBalPrice: ${veBalPrice.price}`,
            );
        }

        console.log(`✅ Calculated Hidden Hand APR: ${apr.toFixed(4)} (${(apr * 100).toFixed(2)}%)`);
        return apr;
    } catch (error) {
        console.error(`❌ Error calculating Hidden Hand APR for timestamp ${timestamp}:`, error);
        throw error;
    }
};

export class VeBalVotingAprService implements PoolAprService {
    constructor() {}

    public getAprServiceName(): string {
        return 'VeBalVotingAprService';
    }

    async getApr(): Promise<number> {
        try {
            console.log(`🔄 Starting VeBalVotingAprService APR calculation...`);

            // Get current timestamp from API
            const currentRound = await fetchHiddenHandRound();
            const timestamp = currentRound.timestamp;

            console.log(`📅 Using base timestamp: ${timestamp} (${new Date(timestamp * 1000).toISOString()})`);

            // Try to get APRs for last 3 weeks
            const aprPromises = [
                getHiddenHandAPR(timestamp - 1 * 604800), // 1 week ago
                getHiddenHandAPR(timestamp - 2 * 604800), // 2 weeks ago
                getHiddenHandAPR(timestamp - 3 * 604800), // 3 weeks ago
            ];

            const aprs = await Promise.allSettled(aprPromises);

            // Log results for each week
            aprs.forEach((result, index) => {
                const weekNum = index + 1;
                if (result.status === 'fulfilled') {
                    console.log(`✅ Week ${weekNum} APR: ${(result.value * 100).toFixed(2)}%`);
                } else {
                    console.warn(`⚠️  Week ${weekNum} APR failed: ${result.reason}`);
                }
            });

            // Filter successful APRs
            const successfulAprs = aprs
                .filter((apr): apr is PromiseFulfilledResult<number> => apr.status === 'fulfilled')
                .map((apr) => apr.value)
                .filter((apr) => Number.isFinite(apr) && apr >= 0);

            if (successfulAprs.length === 0) {
                throw new Error('Failed to fetch any valid APRs for the last 3 weeks');
            }

            // Calculate average
            const averageApr = successfulAprs.reduce((acc, val) => acc + val, 0) / successfulAprs.length;

            console.log(`📊 VeBalVotingAprService Summary:`, {
                successfulWeeks: successfulAprs.length,
                totalWeeks: 3,
                individualAprs: successfulAprs.map((apr) => (apr * 100).toFixed(2) + '%'),
                averageApr: (averageApr * 100).toFixed(2) + '%',
            });

            return averageApr;
        } catch (error) {
            console.error(`❌ VeBalVotingAprService failed to calculate APR:`, error);
            throw error;
        }
    }

    async updateAprForPools(pools: PoolForAPRs[]): Promise<void> {
        const apr = await this.getApr();

        await prisma.prismaPoolAprItem.upsert({
            where: { id_chain: { id, chain } },
            create: {
                id,
                chain,
                poolId: vebalPool,
                apr,
                title: 'Voting APR',
                type: 'VOTING',
            },
            update: { apr },
        });
    }
}
