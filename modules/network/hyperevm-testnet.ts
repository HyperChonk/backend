import { ethers } from 'ethers';
import { env } from '../../apps/env';
import { every } from '../../apps/scheduler/intervals';
import config from '../../config';
import {
    BoostedPoolAprService,
    DynamicSwapFeeFromEventsAprService,
    GaugeAprService,
    MorphoRewardsAprService,
    SwapFeeAprService,
    VeBalProtocolAprService,
    VeBalVotingAprService,
    YbTokensAprService,
} from '../pool/lib/apr-data-sources';
import { AaveApiAprService } from '../pool/lib/apr-data-sources/aave-api-apr-handler';
import { QuantAmmAprService } from '../pool/lib/apr-data-sources/quant-amm-apr-handler';
import { BalancerSubgraphService } from '../subgraphs/balancer-subgraph/balancer-subgraph.service';
import { UserSyncAuraBalanceService } from '../user/lib/user-sync-aura-balance.service';
import { UserSyncGaugeBalanceService } from '../user/lib/user-sync-gauge-balance.service';
import { UserSyncVebalLockBalanceService } from '../user/lib/user-sync-vebal-lock-balance.service';
import { DeploymentEnv, NetworkConfig, NetworkData } from './network-config-types';

export const data: NetworkData = config.HYPEREVM_TESTNET;

export const hyperevmTestnetNetworkConfig: NetworkConfig = {
    data,
    provider: new ethers.providers.JsonRpcProvider({ url: data.rpcUrl, timeout: 60000 }),
    poolAprServices: [
        new YbTokensAprService(data.ybAprConfig, data.chain.prismaId),
        new BoostedPoolAprService(),
        new SwapFeeAprService(),
        new DynamicSwapFeeFromEventsAprService(),
        new GaugeAprService(),
        new VeBalProtocolAprService(data.rpcUrl),
        new VeBalVotingAprService(),
        new MorphoRewardsAprService(),
        new AaveApiAprService(),
        new QuantAmmAprService(),
    ],
    userStakedBalanceServices: [
        new UserSyncGaugeBalanceService(),
        new UserSyncAuraBalanceService(),
        new UserSyncVebalLockBalanceService(),
    ],
    services: {
        balancerSubgraphService: new BalancerSubgraphService(data.subgraphs.balancer, 'HYPEREVM_TESTNET'),
    },
    /*
    For sub-minute jobs we set the alarmEvaluationPeriod and alarmDatapointsToAlarm to 1 instead of the default 3.
    This is needed because the minimum alarm period is 1 minute and we want the alarm to trigger already after 1 minute instead of 3.

    For every 1 days jobs we set the alarmEvaluationPeriod and alarmDatapointsToAlarm to 1 instead of the default 3.
    This is needed because the maximum alarm evaluation period is 1 day (period * evaluationPeriod).
    */
    workerJobs: [
        // Core pool management jobs
        {
            name: 'update-liquidity-for-inactive-pools',
            interval: every(10, 'minutes'),
        },
        {
            name: 'update-pool-apr',
            interval: every(2, 'minutes'),
        },
        {
            name: 'update-7-30-days-swap-apr',
            interval: every(8, 'hours'),
        },
        {
            name: 'load-on-chain-data-for-pools-with-active-updates',
            interval: every(1, 'minutes'),
        },
        {
            name: 'sync-new-pools-from-subgraph',
            interval: every(2, 'minutes'),
        },
        {
            name: 'sync-changed-pools',
            interval: every(30, 'seconds'),
            alarmEvaluationPeriod: (env.DEPLOYMENT_ENV as DeploymentEnv) === 'canary' ? 3 : 1,
            alarmDatapointsToAlarm: (env.DEPLOYMENT_ENV as DeploymentEnv) === 'canary' ? 3 : 1,
        },

        // User balance sync jobs
        {
            name: 'user-sync-wallet-balances-for-all-pools',
            interval: every(20, 'seconds'),
            alarmEvaluationPeriod: (env.DEPLOYMENT_ENV as DeploymentEnv) === 'canary' ? 3 : 1,
            alarmDatapointsToAlarm: (env.DEPLOYMENT_ENV as DeploymentEnv) === 'canary' ? 3 : 1,
        },
        {
            name: 'update-fee-volume-yield-all-pools',
            interval: every(1, 'hours'),
        },

        // V3-specific jobs
        {
            name: 'add-pools-v3',
            interval: every(30, 'seconds'),
        },
        {
            name: 'sync-pools-v3',
            interval: every(30, 'seconds'),
        },
        {
            name: 'sync-join-exits-v3',
            interval: every(1, 'minutes'),
        },
        {
            name: 'sync-swaps-v3',
            interval: every(1, 'minutes'),
        },
        {
            name: 'update-liquidity-24h-ago-v3',
            interval: every(5, 'minutes'),
        },
        {
            name: 'sync-snapshots-v3',
            interval: every(90, 'minutes'),
        },
        {
            name: 'sync-hook-data',
            interval: every(1, 'hours'),
        },

        // Utility jobs
        {
            name: 'sync-erc4626-unwrap-rate',
            interval: (env.DEPLOYMENT_ENV as DeploymentEnv) === 'canary' ? every(60, 'minutes') : every(20, 'minutes'),
        },
        {
            name: 'sync-weights',
            interval: (env.DEPLOYMENT_ENV as DeploymentEnv) === 'canary' ? every(60, 'minutes') : every(10, 'minutes'),
        },
    ],
};
