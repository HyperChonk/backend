import type { BaseProvider } from '@ethersproject/providers';
import type { Chain } from '@prisma/client';
import type { GqlChain, GqlHookType } from '../../apps/api/gql/generated-schema';
import type { PoolAprService } from '../pool/pool-types';
import { SftmxSubgraphService } from '../sources/subgraphs/sftmx-subgraph/sftmx.service';
import type { BalancerSubgraphService } from '../subgraphs/balancer-subgraph/balancer-subgraph.service';
import type { UserStakedBalanceService } from '../user/user-types';
import type { YbAprConfig } from './apr-config-types';

export interface NetworkConfig {
    data: NetworkData;
    poolAprServices: PoolAprService[];
    userStakedBalanceServices: UserStakedBalanceService[];
    provider: BaseProvider;
    workerJobs: WorkerJob[];
    services: NetworkServices;
}

interface NetworkServices {
    balancerSubgraphService: BalancerSubgraphService;
    sftmxSubgraphService?: SftmxSubgraphService;
}

export interface WorkerJob {
    name: string;
    interval: number;
    alarmEvaluationPeriod?: number;
    alarmDatapointsToAlarm?: number;
}

export type DeploymentEnv = 'canary' | 'main';
export type DeploymentEnvExtended = DeploymentEnv | 'development' | 'staging' | 'production';

export interface NetworkData {
    chain: {
        slug: string;
        id: number;
        nativeAssetAddress: string;
        wrappedNativeAssetAddress: string;
        prismaId: Chain;
        gqlId: GqlChain;
    };
    eth: {
        address: string;
        addressFormatted: string;
        symbol: string;
        name: string;
    };
    weth: {
        address: string;
        addressFormatted: string;
    };
    rpcUrl: string;
    rpcMaxBlockRange: number;
    acceptableSGLag: number;
    coingecko: {
        nativeAssetId: string;
        platformId: string;
        excludedTokenAddresses: string[];
    };
    subgraphs: {
        startDate: string;
        balancer: string;
        balancerV3?: string;
        balancerPoolsV3?: string;
        masterchef?: string;
        reliquary?: string;
        sftmx?: string;
        sts?: string;
        beetsBar?: string;
        gauge?: string;
        aura?: string;
        cowAmm?: string;
    };
    protocolToken: 'beets' | 'bal';
    beets?: {
        address: string;
    };
    fbeets?: {
        address: string;
        farmId: string;
        poolId: string;
        poolAddress: string;
    };
    sftmx?: {
        stakingContractAddress: string;
        sftmxAddress: string;
    };
    sts?: {
        address: string;
        baseAprUrl: string;
        validatorFee: number;
    };
    bal?: {
        address: string;
    };
    veBal?: {
        address: string;
        bptAddress: string;
        delegationProxy: string;
    };
    gaugeControllerAddress?: string;
    gaugeControllerHelperAddress?: string;
    gyro?: {
        config: string;
    };
    balancer: {
        v2: {
            vaultAddress: string;
            defaultSwapFeePercentage: string;
            defaultYieldFeePercentage: string;
            tokenAdmin?: string;
            balancerQueriesAddress: string;
        };
        v3: {
            vaultAddress: string;
            routerAddress: string;
            defaultSwapFeePercentage: string;
            defaultYieldFeePercentage: string;
            tokenAdmin?: string;
        };
    };
    hooks?: Record<string, GqlHookType>;
    multicall: string;
    multicall3: string;
    masterchef?: {
        address: string;
        excludedFarmIds: string[];
    };
    ybAprConfig: YbAprConfig;
    reliquary?: {
        address: string;
        excludedFarmIds: string[];
    };
    avgBlockSpeed: number;
    sor?: {
        poolIdsToExclude?: string[];
    };
    datastudio?: {
        [key in DeploymentEnv]: {
            user: string;
            sheetId: string;
            compositionTabName: string;
            databaseTabName: string;
            emissionDataTabName: string;
        };
    };
    monitoring: {
        [key in DeploymentEnv]: {
            alarmTopicArn: string;
        };
    };
}
