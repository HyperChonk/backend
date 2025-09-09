import config from '../../config';
import { addPools as addPoolsV2 } from '../actions/pool/v2/add-pools';
import { addPools as addPoolsV3 } from '../actions/pool/v3/add-pools';
import { getV2SubgraphClient } from '../subgraphs/balancer-subgraph';
import {
    syncOnchainDataForAllPools as syncOnchainDataForAllPoolsV2,
    syncChangedPools as syncChangedPoolsV2,
    syncOnChainDataForPools as syncOnChainDataForPoolsV2,
} from '../actions/pool/v2';
import { getViemClient } from '../sources/viem-client';
import { getPoolsSubgraphClient, getV3JoinedSubgraphClient, getVaultSubgraphClient } from '../sources/subgraphs';
import { prisma } from '../../prisma/prisma-client';
import { updateLiquidity24hAgo, updateLiquidityValuesForPools } from '../actions/pool/update-liquidity';
import { Chain, PrismaLastBlockSyncedCategory } from '@prisma/client';
import { syncPools as syncPoolsV3 } from '../actions/pool/v3/sync-pools';
import { syncTokenPairs } from '../actions/pool/v3/sync-tokenpairs';
import { syncHookData } from '../actions/pool/v3/sync-hook-data';
import { getLastSyncedBlock, upsertLastSyncedBlock } from '../actions/last-synced-block';
import { getChangedPoolsV3 } from '../sources/logs';
import { syncBptBalancesFromSubgraph } from '../actions/user/bpt-balances/helpers/sync-bpt-balances-from-subgraph';
import { syncHookReviews } from '../actions/content/sync-hook-reviews';
import { syncErc4626Tokens } from '../actions/token/sync-erc4626-tokens';
import { syncRateProviderReviews } from '../actions/content/sync-rate-provider-reviews';
import { PoolWithMappedJsonFields } from '../../prisma/prisma-types';

export function PoolController(tracer?: any) {
    return {
        async addPoolsV2(chain: Chain) {
            const subgraphUrl = config[chain].subgraphs.balancer;

            // Guard against unconfigured chains
            if (!subgraphUrl) {
                console.log(`⏭️  Skipping addPoolsV2 for chain ${chain}: V2 subgraph not configured`);
                return [];
            }

            const subgraphService = getV2SubgraphClient(subgraphUrl, chain);

            return addPoolsV2(subgraphService, chain);
        },

        async syncOnchainDataForAllPoolsV2(chain: Chain) {
            const vaultAddress = config[chain].balancer.v2.vaultAddress;
            const balancerQueriesAddress = config[chain].balancer.v2.balancerQueriesAddress;
            const yieldProtocolFeePercentage = config[chain].balancer.v2.defaultYieldFeePercentage;
            const swapProtocolFeePercentage = config[chain].balancer.v2.defaultSwapFeePercentage;
            const gyroConfig = config[chain].gyro?.config;

            // Guard against unconfigured chains
            if (!vaultAddress) {
                console.log(`⏭️  Skipping syncOnchainDataForAllPoolsV2 for chain ${chain}: V2 vault not configured`);
                return [];
            }

            const viemClient = getViemClient(chain);
            const latestBlock = await viemClient.getBlockNumber();

            return syncOnchainDataForAllPoolsV2(
                Number(latestBlock),
                chain,
                vaultAddress,
                balancerQueriesAddress,
                yieldProtocolFeePercentage,
                swapProtocolFeePercentage,
                gyroConfig,
            );
        },

        async syncOnchainDataForPoolsV2(chain: Chain, poolIds: string[]) {
            const vaultAddress = config[chain].balancer.v2.vaultAddress;
            const balancerQueriesAddress = config[chain].balancer.v2.balancerQueriesAddress;
            const yieldProtocolFeePercentage = config[chain].balancer.v2.defaultYieldFeePercentage;
            const swapProtocolFeePercentage = config[chain].balancer.v2.defaultSwapFeePercentage;
            const gyroConfig = config[chain].gyro?.config;

            // Guard against unconfigured chains
            if (!vaultAddress) {
                console.log(`⏭️  Skipping syncOnchainDataForPoolsV2 for chain ${chain}: V2 vault not configured`);
                return [];
            }

            const viemClient = getViemClient(chain);
            const latestBlock = await viemClient.getBlockNumber();

            return syncOnChainDataForPoolsV2(
                poolIds,
                Number(latestBlock),
                chain,
                vaultAddress,
                balancerQueriesAddress,
                yieldProtocolFeePercentage,
                swapProtocolFeePercentage,
                gyroConfig,
            );
        },

        async syncChangedPoolsV2(chain: Chain) {
            const vaultAddress = config[chain].balancer.v2.vaultAddress;
            const balancerQueriesAddress = config[chain].balancer.v2.balancerQueriesAddress;
            const yieldProtocolFeePercentage = config[chain].balancer.v2.defaultYieldFeePercentage;
            const swapProtocolFeePercentage = config[chain].balancer.v2.defaultSwapFeePercentage;
            const gyroConfig = config[chain].gyro?.config;

            // Guard against unconfigured chains
            if (!vaultAddress) {
                console.log(`⏭️  Skipping syncChangedPoolsV2 for chain ${chain}: V2 vault not configured`);
                return [];
            }

            return syncChangedPoolsV2(
                chain,
                vaultAddress,
                balancerQueriesAddress,
                yieldProtocolFeePercentage,
                swapProtocolFeePercentage,
                gyroConfig,
            );
        },

        async updateLiquidity24hAgoV2(chain: Chain) {
            const {
                subgraphs: { balancer },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancer) {
                console.log(`⏭️  Skipping updateLiquidity24hAgoV2 for chain ${chain}: V2 subgraph not configured`);
                return [];
            }

            const subgraph = getV2SubgraphClient(balancer, chain);

            const poolIds = await prisma.prismaPoolDynamicData.findMany({
                where: { chain },
                select: { poolId: true },
            });

            const updates = await updateLiquidity24hAgo(
                poolIds.map(({ poolId }) => poolId),
                subgraph,
                chain,
            );

            return updates;
        },

        async updateLiquidityValuesForInactivePools(chain: Chain) {
            const poolTokens = await prisma.prismaPoolToken.findMany({
                where: {
                    chain,
                    updatedAt: {
                        // Do the update only when the pool wasn't synced in the last 10 minutes
                        lt: new Date(Date.now() - 60 * 10 * 1000),
                    },
                },
            });

            const ids = [...new Set(poolTokens.map((pt) => pt.poolId))];

            await updateLiquidityValuesForPools(chain, ids);

            return ids;
        },
        async addPoolsV3(chain: Chain, checkForExistingPools = true) {
            console.log('//////// Starting addPoolsV3 for chain', chain);
            const {
                subgraphs: { balancerV3, balancerPoolsV3 },
                balancer: {
                    v3: { vaultAddress },
                },
                hooks,
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3 || !balancerPoolsV3) {
                console.log(`⏭️  Skipping addPoolsV3 for chain ${chain}: V3 subgraphs not configured`);
                return [];
            }

            const viemClient = getViemClient(chain);

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);
            const poolsSubgraphClient = getPoolsSubgraphClient(balancerPoolsV3, chain);
            const subgraphClient = getV3JoinedSubgraphClient(vaultSubgraphClient, poolsSubgraphClient);

            const fromBlock = await getLastSyncedBlock(chain, PrismaLastBlockSyncedCategory.ADD_POOLS_V3);
            const latestBlock = await subgraphClient.lastSyncedBlock();
            const changedIds = await subgraphClient.getChangedPools(fromBlock);

            console.log('//////// From block', fromBlock);
            console.log('//////// Latest block', latestBlock);
            console.log('//////// Changed IDs', changedIds.length);

            if (changedIds.length === 0) {
                return [];
            }

            const dbIds = (
                await prisma.prismaPool.findMany({
                    where: { chain, protocolVersion: 3 },
                    select: { id: true },
                })
            ).map(({ id }) => id);

            let newIds: string[] = [];
            if (checkForExistingPools) {
                newIds = changedIds.filter((id) => !dbIds.includes(id));
            } else {
                newIds = changedIds;
            }

            if (newIds.length === 0) {
                return [];
            }

            const pools = await subgraphClient.getAllInitializedPools({ id_in: newIds });
            console.log('//////// Pools', pools.length);
            newIds = pools.map(({ id }) => id); // Some pools are missing in pools subgraph and then we don't know it's type
            console.log('//////// New IDs', newIds.length);

            if (newIds.length === 0) {
                return [];
            }

            const inserts = await addPoolsV3(pools, viemClient, vaultAddress, chain, latestBlock);
            console.log('//////// Inserts', inserts.length);
            await syncBptBalancesFromSubgraph(newIds, vaultSubgraphClient, chain);

            // Sync token flags for the new tokens
            await syncErc4626Tokens(
                getViemClient(chain),
                chain,
                inserts.flatMap(({ tokens }) => tokens),
            );

            await syncRateProviderReviews();

            if (hooks) {
                await syncHookReviews();
            }

            await upsertLastSyncedBlock(chain, PrismaLastBlockSyncedCategory.ADD_POOLS_V3, latestBlock);

            return newIds;
        },
        /**
         * Syncs database pools state with the onchain state
         *
         * @param chainId
         */
        async syncPoolsV3(chain: Chain) {
            const {
                subgraphs: { balancerV3, balancerPoolsV3 },
                balancer: {
                    v3: { vaultAddress, routerAddress },
                },
                acceptableSGLag,
            } = config[chain];

            // Guard against unconfigured chains
            if (!vaultAddress || !balancerV3 || !balancerPoolsV3) {
                console.log(`⏭️  Skipping syncPoolsV3 for chain ${chain}: V3 not configured`);
                return [];
            }

            const viemClient = getViemClient(chain);
            const subgraphClient = getVaultSubgraphClient(balancerV3, chain);

            const fromBlock = await getLastSyncedBlock(chain, PrismaLastBlockSyncedCategory.POOLS_V3);
            const rpcLatestBlock = await viemClient.getBlockNumber().then(Number);
            const sgLastSyncedBlock = await subgraphClient.lastSyncedBlock();

            // Guard against subgraph lag
            let useSubgraph = true;
            if (rpcLatestBlock - sgLastSyncedBlock > acceptableSGLag) {
                useSubgraph = false;
            }

            const latestBlock = useSubgraph ? sgLastSyncedBlock : rpcLatestBlock;

            if (fromBlock === undefined || fromBlock > latestBlock) {
                return [];
            }

            // Sepolia vault deployment block, uncomment to test from the beginning
            // const fromBlock = 5274748n;

            let changedIds: string[] = [];
            if (useSubgraph) {
                changedIds = await subgraphClient.getChangedPools(fromBlock);
            } else {
                changedIds = await getChangedPoolsV3(vaultAddress, viemClient, BigInt(fromBlock), BigInt(latestBlock));
            }

            if (changedIds.length === 0) {
                return [];
            }

            const dbPools = (await prisma.prismaPool.findMany({
                where: { chain, protocolVersion: 3, id: { in: changedIds } },
                select: { id: true, type: true, hook: true, typeData: true },
            })) as PoolWithMappedJsonFields[];

            const ids = await syncPoolsV3(dbPools, chain, vaultAddress, viemClient, latestBlock);
            await syncTokenPairs(ids, viemClient, routerAddress, chain);
            await upsertLastSyncedBlock(chain, PrismaLastBlockSyncedCategory.POOLS_V3, latestBlock);

            return ids;
        },
        async updateLiquidity24hAgoV3(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            // Guard against unconfigured chains
            const subgraph = balancerV3 && getVaultSubgraphClient(balancerV3, chain);

            if (!subgraph) {
                console.log(`⏭️  Skipping updateLiquidity24hAgoV3 for chain ${chain}: V3 subgraph not configured`);
                return [];
            }

            const poolIds = await prisma.prismaPoolDynamicData.findMany({
                where: { chain },
                select: { poolId: true },
            });

            const updates = await updateLiquidity24hAgo(
                poolIds.map(({ poolId }) => poolId),
                subgraph,
                chain,
            );

            return updates;
        },
        async syncHookData(chain: Chain) {
            const { hooks } = config[chain];

            // Guard against unconfigured chains
            if (!hooks) {
                // Chain doesn't have hooks
                return;
            }

            // Get hook addresses from the database
            const poolsWithHooks = await prisma.prismaPool.findMany({
                where: { chain, hook: { path: ['address'], string_starts_with: '0x' } },
            });

            const viemClient = getViemClient(chain);

            const ids = await syncHookData(poolsWithHooks, viemClient);

            return ids;
        },
    };
}
