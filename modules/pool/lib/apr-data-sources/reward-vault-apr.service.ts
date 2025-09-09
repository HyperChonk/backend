import { Chain, PrismaPoolAprItem, PrismaPoolAprType, PrismaPoolStaking, PrismaPoolStakingType } from '@prisma/client';
import { prisma } from '../../../../prisma/prisma-client';
import { PoolForAPRs } from '../../../../prisma/prisma-types';
import { PoolAprService } from '../../pool-types';
import { berachainApiClient } from './berachain-api-client';

export class RewardVaultAprService implements PoolAprService {
    public getAprServiceName(): string {
        return 'RewardVaultAprService';
    }

    public async updateAprForPools(pools: PoolForAPRs[]): Promise<void> {
        const berachainPools = pools.filter((pool) => pool.chain === Chain.BERACHAIN);
        if (berachainPools.length === 0) {
            // no Berachain pools to update, skip
            return;
        }

        const { stakingEntries, aprItems } = await this.getStakingAndAprItems(berachainPools);

        await prisma.$transaction([
            // Create staking entries (skip duplicates since reward vault addresses are immutable)
            prisma.prismaPoolStaking.createMany({
                data: stakingEntries,
                skipDuplicates: true,
            }),
            // Create/update APR items
            ...aprItems.map((item) =>
                prisma.prismaPoolAprItem.upsert({
                    where: { id_chain: { id: item.id, chain: item.chain } },
                    update: { apr: item.apr },
                    create: item,
                }),
            ),
        ]);
    }

    private async getStakingAndAprItems(pools: PoolForAPRs[]) {
        // Get pool addresses to filter the API query
        const poolAddresses = pools.map((pool) => pool.address);

        // Get RewardVaults info for specific pools
        const rewardVaults = await berachainApiClient.getRewardVaults(poolAddresses);

        // Find all pools with an attached RewardVault (i.e. stakeable pools)
        const bptAddresses = Object.keys(rewardVaults);
        const poolsWithRewardVault = pools.filter((pool) => {
            return bptAddresses.includes(pool.address);
        });

        // Create staking entries for each pool with a reward vault
        const stakingEntries: PrismaPoolStaking[] = poolsWithRewardVault.map((pool) => ({
            id: rewardVaults[pool.address].rewardVaultAddress,
            chain: pool.chain,
            poolId: pool.id,
            type: PrismaPoolStakingType.REWARD_VAULT,
            address: rewardVaults[pool.address].rewardVaultAddress,
        }));

        // Create APR items for each pool with a reward vault
        const aprItems: PrismaPoolAprItem[] = poolsWithRewardVault.map((pool) => ({
            id: `${pool.id}-rewardvault-apr`,
            chain: pool.chain,
            poolId: pool.id,
            title: 'Berachain Reward Vault APR',
            group: null,
            apr: Number(rewardVaults[pool.address].apr),
            type: PrismaPoolAprType.REWARD_VAULT,
            rewardTokenAddress: '0x656b95E550C07a9ffe548bd4085c72418Ceb1dba',
            rewardTokenSymbol: 'BGT',
        }));

        return { stakingEntries, aprItems };
    }
}
