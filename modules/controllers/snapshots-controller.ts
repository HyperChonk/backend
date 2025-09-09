import { Chain } from '@prisma/client';
import config from '../../config';
import { prisma } from '../../prisma/prisma-client';
import { syncSnapshotsV2, fillMissingSnapshotsV2, syncSnapshots } from '../actions/snapshots';
import { PoolSnapshotService } from '../actions/snapshots/pool-snapshot-service';
import { getVaultSubgraphClient } from '../sources/subgraphs';
import { getV2SubgraphClient } from '../subgraphs/balancer-subgraph';
import { updateLifetimeValues } from '../actions/pool/update-liftetime-values';
import { roundToNextMidnight } from '../common/time';

/**
 * Controller responsible for configuring and executing ETL actions.
 *
 * @example
 * ```ts
 * const snapshotsController = SnapshotsController();
 * await snapshotsController.syncSnapshotsV3('1');
 * ```
 *
 * @param name - the name of the action
 * @param chain - the chain to run the action on
 * @returns a controller with configured action handlers
 */
export function SnapshotsController(tracer?: any) {
    // Setup tracing
    // ...
    return {
        async syncSnapshotsV2(chain: Chain) {
            const {
                subgraphs: { balancer },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancer) {
                console.log(`⏭️  Skipping syncSnapshotsV2 for chain ${chain}: V2 subgraph not configured`);
                return [];
            }

            const subgraphClient = getV2SubgraphClient(balancer, chain);
            const entries = await syncSnapshotsV2(subgraphClient, chain);
            // update lifetime values based on snapshots
            await updateLifetimeValues(chain, 2);
            return entries;
        },
        async syncSnapshotForPools(poolIds: string[], chain: Chain, reload = false) {
            const {
                subgraphs: { balancer },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancer) {
                console.log(`⏭️  Skipping syncSnapshotForPools for chain ${chain}: V2 subgraph not configured`);
                return [];
            }

            const prices = await prisma.prismaTokenCurrentPrice
                .findMany({
                    where: {
                        chain,
                    },
                    select: {
                        tokenAddress: true,
                        price: true,
                    },
                })
                .then((prices) => prices.reduce((acc, p) => ({ ...acc, [p.tokenAddress]: p.price }), {}));

            const subgraphClient = getV2SubgraphClient(balancer, chain);
            const service = new PoolSnapshotService(subgraphClient, chain, prices);
            const entries = await service.loadAllSnapshotsForPools(poolIds, reload);

            return entries;
        },
        async syncSnapshotsV3(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3) {
                console.log(`⏭️  Skipping syncSnapshotsV3 for chain ${chain}: V3 subgraph not configured`);
                return [];
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);
            const entries = await syncSnapshots(vaultSubgraphClient, 'SNAPSHOTS_V3', chain);
            // update lifetime values based on snapshots
            await updateLifetimeValues(chain, 3);
            return entries;
        },
        async syncAllSnapshotsV3(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3) {
                console.log(`⏭️  Skipping syncAllSnapshotsV3 for chain ${chain}: V3 subgraph not configured`);
                return [];
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);
            const entries = await syncSnapshots(vaultSubgraphClient, 'SNAPSHOTS_V3', chain, {
                startFromLastSyncedBlock: false,
                syncPoolsWithoutUpdates: true,
            });
            // update lifetime values based on snapshots
            await updateLifetimeValues(chain, 3);
            return entries;
        },
        async forwardFillSnapshotsForPoolsWithoutUpdatesV3(chain: Chain) {
            // To be run as a daily task, 1-2h after midnight, to make sure all pools have current day snapshots
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3) {
                console.log(
                    `⏭️  Skipping forwardFillSnapshotsForPoolsWithoutUpdatesV3 for chain ${chain}: V3 subgraph not configured`,
                );
                return [];
            }

            const currentMidnight = roundToNextMidnight();

            // Find pools without snapshots for the current midnight
            const ids = await prisma.prismaPool
                .findMany({
                    where: {
                        chain,
                        protocolVersion: 3,
                    },
                    select: {
                        id: true,
                    },
                })
                .then((pools) => pools.map((pool) => pool.id));

            const snapshotPoolIds = await prisma.prismaPoolSnapshot
                .findMany({
                    where: {
                        chain,
                        protocolVersion: 3,
                        timestamp: currentMidnight,
                    },
                    select: {
                        poolId: true,
                    },
                })
                .then((snapshots) => snapshots.map((s) => s.poolId));

            const poolIds = ids.filter((id) => !snapshotPoolIds.includes(id));

            if (poolIds.length === 0) {
                return [];
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);
            const entries = await syncSnapshots(vaultSubgraphClient, 'SNAPSHOTS_V3', chain, {
                startFromLastSyncedBlock: true,
                syncPoolsWithoutUpdates: true,
                poolIds,
            });

            // update lifetime values based on snapshots
            return entries;
        },
        async fillMissingSnapshotsV2(chain: Chain) {
            const entries = await fillMissingSnapshotsV2(chain);
            return entries;
        },
    };
}
