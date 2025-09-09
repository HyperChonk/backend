import {
    getSdk,
    BalancerPoolSnapshotsQueryVariables,
    BalancerPoolSnapshotFragment,
    BalancerPoolsQueryVariables,
    BalancerSwapsQueryVariables,
    BalancerSwapsQuery,
    BalancerSwapFragment,
    Swap_OrderBy,
    OrderDirection,
    BalancerPoolQueryVariables,
    BalancerPoolQuery,
    BalancerPoolShareFragment,
    PoolShare_OrderBy,
    BalancerPoolFragment,
    BalancerJoinExitsQueryVariables,
    BalancerJoinExitsQuery,
} from './generated/balancer-subgraph-types';
import { subgraphLoadAll, createGraphQLClientWithRetry } from '../subgraph-util';
import { Chain, Prisma } from '@prisma/client';
import { GraphQLClient } from 'graphql-request';

export class BalancerSubgraphService {
    private sdk: ReturnType<typeof getSdk>;

    constructor(subgraphUrl: string, private chain: Chain) {
        this.sdk = getSdk(createGraphQLClientWithRetry(subgraphUrl));
    }

    public async lastSyncedBlock() {
        try {
            const { meta } = await this.sdk.BalancerGetMeta();

            if (!meta) {
                throw new Error('Missing meta data');
            }

            return Number(meta.block.number);
        } catch (error: any) {
            const status = error?.response?.status;
            console.warn(`BalancerGetMeta failed${status ? ` (status ${status})` : ''}. Returning 0 to avoid crash.`);
            return 0;
        }
    }

    public async getAllPoolSnapshots(
        args: BalancerPoolSnapshotsQueryVariables,
    ): Promise<BalancerPoolSnapshotFragment[]> {
        return subgraphLoadAll<BalancerPoolSnapshotFragment>(this.sdk.BalancerPoolSnapshots, 'poolSnapshots', args);
    }

    public async getSwaps(args: BalancerSwapsQueryVariables): Promise<BalancerSwapsQuery> {
        try {
            return await this.sdk.BalancerSwaps(args);
        } catch (error: any) {
            console.warn(`BalancerSwaps query failed. Skipping. Error: ${error?.message || error}`);
            return { swaps: [] } as any;
        }
    }

    public async getAllSwapsWithPaging({
        where,
        block,
        startTimestamp,
    }: Pick<BalancerSwapsQueryVariables, 'where' | 'block'> & { startTimestamp: number }): Promise<
        BalancerSwapFragment[]
    > {
        const limit = 1000;
        let timestamp = startTimestamp;
        let hasMore = true;
        let swaps: BalancerSwapFragment[] = [];

        while (hasMore) {
            let response: BalancerSwapsQuery = { swaps: [] } as any;
            try {
                response = await this.sdk.BalancerSwaps({
                    where: { ...where, timestamp_gt: timestamp },
                    block,
                    orderBy: Swap_OrderBy.Timestamp,
                    orderDirection: OrderDirection.Asc,
                    first: limit,
                });
            } catch (error: any) {
                console.warn(`BalancerSwaps(paged) failed. Stopping pagination. Error: ${error?.message || error}`);
                break;
            }

            swaps = [...swaps, ...response.swaps];
            if (response.swaps.length < limit) {
                hasMore = false;
            } else {
                timestamp = response.swaps[response.swaps.length - 1].timestamp;
            }
        }

        return swaps;
    }

    public async getPool(args: BalancerPoolQueryVariables): Promise<BalancerPoolQuery> {
        return this.sdk.BalancerPool(args);
    }

    public async getAllPoolSharesWithBalance(
        poolIds: string[],
        excludedAddresses: string[],
        startBlock?: number,
    ): Promise<Prisma.PrismaUserWalletBalanceCreateManyInput[]> {
        const allPoolShares: BalancerPoolShareFragment[] = [];
        let hasMore = true;
        let id = `0`;
        const pageSize = 1000;

        while (hasMore) {
            const shares = await this.sdk.BalancerPoolShares({
                where: {
                    id_gt: id,
                    // Fetch all pools when requesting more than 100 pools
                    poolId_in: poolIds.length > 0 && poolIds.length < 100 ? poolIds : undefined,
                    userAddress_not_in: excludedAddresses,
                    _change_block: startBlock && startBlock > 0 ? { number_gte: startBlock } : undefined,
                },
                orderBy: PoolShare_OrderBy.Id,
                orderDirection: OrderDirection.Asc,
                first: pageSize,
            });

            if (shares.poolShares.length === 0) {
                break;
            }

            if (shares.poolShares.length < pageSize) {
                hasMore = false;
            }

            allPoolShares.push(...shares.poolShares);
            id = shares.poolShares[shares.poolShares.length - 1].id;
        }

        return allPoolShares
            .map((share) => ({
                ...share,
                poolId: share.poolId.id.toLowerCase(),
                chain: this.chain,
                //ensure the user balance isn't negative, unsure how the subgraph ever allows this to happen
                balance: parseFloat(share.balance) < 0 ? '0' : share.balance,
                balanceNum: Math.max(0, parseFloat(share.balance)),
                tokenAddress: share.id.toLowerCase().split('-')[0],
                userAddress: share.id.toLowerCase().split('-')[1],
            }))
            .filter((share) => (poolIds.length > 0 ? poolIds.includes(share.poolId) : true));
    }

    public async getAllPools(
        args: BalancerPoolsQueryVariables,
        applyTotalSharesFilter = true,
    ): Promise<BalancerPoolFragment[]> {
        return subgraphLoadAll<BalancerPoolFragment>(this.sdk.BalancerPools, 'pools', {
            ...args,
            where: {
                totalShares_not: applyTotalSharesFilter ? '0.00000000001' : undefined,
                poolType_not_contains_nocase: 'linear',
                ...args.where,
            },
        });
    }

    public async getPoolJoinExits(args: BalancerJoinExitsQueryVariables): Promise<BalancerJoinExitsQuery> {
        return this.sdk.BalancerJoinExits(args);
    }

    public async getPoolsWithActiveUpdates(timestamp: number): Promise<string[]> {
        const { ampUpdates, gradualWeightUpdates } = await this.sdk.BalancerGetPoolsWithActiveUpdates({
            timestamp: `${timestamp}`,
        });

        return [...ampUpdates, ...gradualWeightUpdates].map((item) => item.poolId.id);
    }
}
