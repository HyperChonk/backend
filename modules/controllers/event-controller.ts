import config from '../../config';

import { BalancerSubgraphService } from '../subgraphs/balancer-subgraph/balancer-subgraph.service';
import { getV2SubgraphClient } from '../subgraphs/balancer-subgraph';
import { syncJoinExits as syncJoinExitsV2 } from '../actions/pool/v2/sync-join-exits';
import { syncJoinExits as syncJoinExitsV3 } from '../actions/pool/v3/sync-join-exits';
import { syncSwaps as syncSwapsV2 } from '../actions/pool/v2/sync-swaps';
import { syncSwaps as syncSwapsV3 } from '../actions/pool/v3/sync-swaps';
import { Chain } from '@prisma/client';
import { updateVolumeAndFees } from '../actions/pool/update-volume-and-fees';
import { getVaultSubgraphClient } from '../sources/subgraphs/balancer-v3-vault';
import { syncLastSwaps } from '../actions/pool/v3/sync-last-swaps';

export function EventController() {
    return {
        async syncJoinExitsV2(chain: Chain) {
            const {
                subgraphs: { balancer },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancer) {
                console.log(`⏭️  Skipping syncJoinExitsV2 for chain ${chain}: V2 subgraph not configured`);
                return [];
            }

            const subgraphClient = new BalancerSubgraphService(balancer, chain);
            const entries = await syncJoinExitsV2(subgraphClient, chain);
            return entries;
        },
        async syncSwapsUpdateVolumeAndFeesV2(chain: Chain) {
            const {
                subgraphs: { balancer },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancer) {
                console.log(
                    `⏭️  Skipping syncSwapsUpdateVolumeAndFeesV2 for chain ${chain}: V2 subgraph not configured`,
                );
                return [];
            }

            const subgraphClient = getV2SubgraphClient(balancer, chain);
            const poolsWithNewSwaps = await syncSwapsV2(subgraphClient, chain);
            await updateVolumeAndFees(chain, poolsWithNewSwaps);

            return poolsWithNewSwaps;
        },
        async syncJoinExitsV3(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3) {
                console.log(`⏭️  Skipping syncJoinExitsV3 for chain ${chain}: V3 subgraph not configured`);
                return [];
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);
            const entries = await syncJoinExitsV3(vaultSubgraphClient, chain);
            return entries;
        },
        async syncSwapsV3(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3) {
                console.log(`⏭️  Skipping syncSwapsV3 for chain ${chain}: V3 subgraph not configured`);
                return [];
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);
            const entries = await syncSwapsV3(vaultSubgraphClient, chain);
            return entries;
        },
        async syncLastSwaps(chain: Chain) {
            const {
                subgraphs: { balancer, balancerV3 },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3) {
                console.log(`⏭️  Skipping syncLastSwaps for chain ${chain}: V3 subgraph not configured`);
                return [];
            }

            // V2 subgraph is optional - pass null if not configured
            const v2Subgraph = balancer ? getV2SubgraphClient(balancer, chain) : null;
            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);
            const entries = await syncLastSwaps(vaultSubgraphClient, v2Subgraph, chain);
            return entries;
        },
        async syncSwapsUpdateVolumeAndFeesV3(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3) {
                console.log(
                    `⏭️  Skipping syncSwapsUpdateVolumeAndFeesV3 for chain ${chain}: V3 subgraph not configured`,
                );
                return [];
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);

            const poolsWithNewSwaps = await syncSwapsV3(vaultSubgraphClient, chain);
            await updateVolumeAndFees(chain, poolsWithNewSwaps);
            return poolsWithNewSwaps;
        },
        async updateVolumeAndFees(chain: Chain) {
            return updateVolumeAndFees(chain);
        },
    };
}
