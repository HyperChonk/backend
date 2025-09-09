import request, { gql } from 'graphql-request';

const url = 'https://api.berachain.com';

const createRewardVaultsQuery = (poolAddresses: string[]) => {
    const whereClause = `where: { chainIn: [BERACHAIN], stakingTokensIn: [${poolAddresses
        .map((id) => `"${id}"`)
        .join(', ')}] }`;

    return gql`
        {
            polGetRewardVaults(${whereClause}) {
                vaults {
                    vaultAddress
                    stakingTokenAddress
                    isVaultWhitelisted
                    dynamicData {
                        apr
                    }
                }
            }
        }
    `;
};

type Vault = {
    vaultAddress: string; // RewardVault address
    stakingTokenAddress: string; // BPT/pool address
    isVaultWhitelisted: boolean; // Only whitelisted RewardVaults has APRs
    dynamicData: {
        apr: string;
    };
};

type BEXApiResponse = {
    polGetRewardVaults: {
        vaults: Vault[];
    };
};

export const berachainApiClient = {
    getRewardVaults: async (poolAddresses: string[]) => {
        // Skip API request if no pool addresses provided
        if (!poolAddresses || poolAddresses.length === 0) {
            console.log('No pool addresses provided, skipping reward vaults API request');
            return {};
        }

        const query = createRewardVaultsQuery(poolAddresses);
        const response = await request<BEXApiResponse>(url, query);

        // Handle the case where the response might be null or undefined
        if (!response || !response.polGetRewardVaults || !response.polGetRewardVaults.vaults) {
            console.warn('No reward vaults data received from Berachain API');
            return {};
        }

        const { vaults } = response.polGetRewardVaults;

        // Map RewardVault info to bpt/staking token addresses
        return Object.fromEntries(
            vaults.map((vault: Vault) => [
                vault.stakingTokenAddress.toLowerCase(),
                {
                    apr: vault.dynamicData.apr,
                    rewardVaultAddress: vault.vaultAddress,
                },
            ]),
        );
    },
};
