import { BalancerSubgraphService } from './balancer-subgraph.service';
import { Chain, Prisma } from '@prisma/client';
import { isChainUnsupported } from '../../../config/chain-support-wrapper';
import {
    BalancerPoolSnapshotsQueryVariables,
    BalancerPoolSnapshotFragment,
    BalancerSwapsQueryVariables,
    BalancerSwapsQuery,
    BalancerSwapFragment,
    BalancerPoolQueryVariables,
    BalancerPoolQuery,
    BalancerPoolFragment,
    BalancerJoinExitsQueryVariables,
    BalancerJoinExitsQuery,
    BalancerPoolsQueryVariables,
} from './generated/balancer-subgraph-types';

/**
 * Enhanced BalancerSubgraphService that automatically handles unsupported chains
 * For supported chains: uses real subgraph service
 * For unsupported chains: returns empty data automatically
 */
export class EnhancedBalancerSubgraphService {
    private realService: BalancerSubgraphService | null = null;
    private isUnsupported: boolean;

    constructor(subgraphUrl: string, private chain: Chain) {
        this.isUnsupported = isChainUnsupported(chain);

        if (!this.isUnsupported) {
            this.realService = new BalancerSubgraphService(subgraphUrl, chain);
        }
    }

    public async lastSyncedBlock(): Promise<number> {
        if (this.isUnsupported) {
            return 0; // Unsupported chains have no synced blocks
        }
        return this.realService!.lastSyncedBlock();
    }

    public async getAllPoolSnapshots(
        args: BalancerPoolSnapshotsQueryVariables,
    ): Promise<BalancerPoolSnapshotFragment[]> {
        if (this.isUnsupported) {
            return [];
        }
        return this.realService!.getAllPoolSnapshots(args);
    }

    public async getSwaps(args: BalancerSwapsQueryVariables): Promise<BalancerSwapsQuery> {
        if (this.isUnsupported) {
            return { swaps: [] };
        }
        return this.realService!.getSwaps(args);
    }

    public async getAllSwapsWithPaging(args: {
        where: any;
        block: any;
        startTimestamp: number;
    }): Promise<BalancerSwapFragment[]> {
        if (this.isUnsupported) {
            return [];
        }
        return this.realService!.getAllSwapsWithPaging(args);
    }

    public async getPool(args: BalancerPoolQueryVariables): Promise<BalancerPoolQuery> {
        if (this.isUnsupported) {
            return { pool: null };
        }
        return this.realService!.getPool(args);
    }

    public async getAllPoolSharesWithBalance(
        poolIds: string[],
        excludedAddresses: string[],
        startBlock?: number,
    ): Promise<Prisma.PrismaUserWalletBalanceCreateManyInput[]> {
        if (this.isUnsupported) {
            return [];
        }
        return this.realService!.getAllPoolSharesWithBalance(poolIds, excludedAddresses, startBlock);
    }

    public async getAllPools(
        args: BalancerPoolsQueryVariables,
        applyTotalSharesFilter = true,
    ): Promise<BalancerPoolFragment[]> {
        if (this.isUnsupported) {
            return [];
        }
        return this.realService!.getAllPools(args, applyTotalSharesFilter);
    }

    public async getPoolJoinExits(args: BalancerJoinExitsQueryVariables): Promise<BalancerJoinExitsQuery> {
        if (this.isUnsupported) {
            return { joinExits: [] };
        }
        return this.realService!.getPoolJoinExits(args);
    }

    public async getPoolsWithActiveUpdates(timestamp: number): Promise<string[]> {
        if (this.isUnsupported) {
            return [];
        }
        return this.realService!.getPoolsWithActiveUpdates(timestamp);
    }
}
