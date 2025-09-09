import config from '../../config';
import { syncSwaps } from '../actions/pool/v3/sync-swaps';
import { updateVolumeAndFees } from '../actions/pool/update-volume-and-fees';
import { getVaultSubgraphClient } from '../sources/subgraphs';
import { Chain } from '@prisma/client';

/**
 * Controller responsible for matching job requests to configured job handlers
 *
 * @param name - the name of the job
 * @param chain - the chain to run the job on
 * @returns a controller with configured job handlers
 */
export function PoolMutationController(tracer?: any) {
    // Setup tracing
    // ...
    return {
        async loadSwapsFeesVolumeForAllPoolsV3(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3) {
                console.log(
                    `⏭️  Skipping loadSwapsFeesVolumeForAllPoolsV3 for chain ${chain}: V3 subgraph not configured`,
                );
                return [];
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);

            const poolsWithNewSwaps = await syncSwaps(vaultSubgraphClient, chain);
            await updateVolumeAndFees(chain, poolsWithNewSwaps);
            return poolsWithNewSwaps;
        },
    };
}
