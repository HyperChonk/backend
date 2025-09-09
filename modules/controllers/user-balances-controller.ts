import { Chain } from '@prisma/client';
import config from '../../config';
import {
    syncBptBalancesV2,
    syncBptBalancesV3,
    syncBptBalancesCowAmm,
    syncBptBalancesFbeets,
} from '../actions/user/bpt-balances';

export function UserBalancesController(tracer?: any) {
    return {
        async syncBalances(chain: Chain) {
            const { subgraphs } = config[chain];
            const { balancer, balancerV3, cowAmm, beetsBar } = subgraphs;

            // Build array of sync operations, only including those with valid subgraph URLs
            const syncOperations = [];

            if (balancer) {
                syncOperations.push(syncBptBalancesV2(chain, balancer));
            }
            if (balancerV3) {
                syncOperations.push(syncBptBalancesV3(chain, balancerV3));
            }
            if (cowAmm) {
                syncOperations.push(syncBptBalancesCowAmm(chain, cowAmm));
            }
            if (beetsBar) {
                syncOperations.push(syncBptBalancesFbeets(chain, beetsBar));
            }

            // Run all available syncs in parallel
            await Promise.all(syncOperations);

            return true;
        },
        async syncUserBalancesFromV2Subgraph(chain: Chain) {
            const {
                subgraphs: { balancer },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancer) {
                console.log(
                    `⏭️  Skipping syncUserBalancesFromV2Subgraph for chain ${chain}: V2 subgraph not configured`,
                );
                return [];
            }

            const syncedBlocks = await syncBptBalancesV2(chain, balancer);
            return syncedBlocks;
        },
        async syncUserBalancesFromV3Subgraph(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3) {
                return [];
            }

            const syncedBlocks = await syncBptBalancesV3(chain, balancerV3);
            return syncedBlocks;
        },
    };
}
