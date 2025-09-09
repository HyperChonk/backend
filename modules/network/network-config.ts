import { Chain } from '@prisma/client';
import { arbitrumNetworkConfig } from './arbitrum';
import { avalancheNetworkConfig } from './avalanche';
import { baseNetworkConfig } from './base';
import { fantomNetworkConfig } from './fantom';
import { fraxtalNetworkConfig } from './fraxtal';
import { gnosisNetworkConfig } from './gnosis';
import { hyperevmNetworkConfig } from './hyperevm';
import { hyperevmTestnetNetworkConfig } from './hyperevm-testnet';
import { berachainNetworkConfig } from './berachain';
import { mainnetNetworkConfig } from './mainnet';
import { modeNetworkConfig } from './mode';
import { NetworkConfig } from './network-config-types';
import { optimismNetworkConfig } from './optimism';
import { polygonNetworkConfig } from './polygon';
import { sepoliaNetworkConfig } from './sepolia';
import { sonicNetworkConfig } from './sonic';
import { zkevmNetworkConfig } from './zkevm';

export const AllNetworkConfigs: { [chainId: string]: NetworkConfig } = {
    '250': fantomNetworkConfig,
    '10': optimismNetworkConfig,
    '1': mainnetNetworkConfig,
    '42161': arbitrumNetworkConfig,
    '137': polygonNetworkConfig,
    '100': gnosisNetworkConfig,
    '1101': zkevmNetworkConfig,
    '43114': avalancheNetworkConfig,
    '8453': baseNetworkConfig,
    '11155111': sepoliaNetworkConfig,
    '252': fraxtalNetworkConfig,
    '34443': modeNetworkConfig,
    '146': sonicNetworkConfig,
    '999': hyperevmNetworkConfig,
    '998': hyperevmTestnetNetworkConfig,
    '80094': berachainNetworkConfig,
};

export const AllNetworkConfigsKeyedOnChain: { [chain in Chain]: NetworkConfig } = {
    FANTOM: fantomNetworkConfig,
    OPTIMISM: optimismNetworkConfig,
    MAINNET: mainnetNetworkConfig,
    ARBITRUM: arbitrumNetworkConfig,
    POLYGON: polygonNetworkConfig,
    GNOSIS: gnosisNetworkConfig,
    ZKEVM: zkevmNetworkConfig,
    AVALANCHE: avalancheNetworkConfig,
    BASE: baseNetworkConfig,
    SEPOLIA: sepoliaNetworkConfig,
    FRAXTAL: fraxtalNetworkConfig,
    MODE: modeNetworkConfig,
    SONIC: sonicNetworkConfig,
    HYPEREVM: hyperevmNetworkConfig,
    HYPEREVM_TESTNET: hyperevmTestnetNetworkConfig,
    BERACHAIN: berachainNetworkConfig,
};

export const BalancerChainIds = [
    '1',
    '137',
    '42161',
    '100',
    '1101',
    '43114',
    '8453',
    '11155111',
    '252',
    '34443',
    '999',
    '998',
    '80094',
];
export const BeethovenChainIds = ['250', '10', '146'];
