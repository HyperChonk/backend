import { Chain } from '@prisma/client';
import _ from 'lodash';
import { prisma } from '../../../prisma/prisma-client';
import { PoolForAPRs, poolsIncludeForAprs } from '../../../prisma/prisma-types';
import { prismaBulkExecuteOperations } from '../../../prisma/prisma-util';
import { chainToChainId } from '../../network/chain-id-to-chain';
import { AllNetworkConfigs } from '../../network/network-config';
import { PoolAprService } from '../pool-types';

const isDevelopment = process.env.NODE_ENV === 'development' || process.env.ENVIRONMENT === 'development';
const isCI = process.env.CI === 'true';

// Configuration for APR service tolerance
const APR_CONFIG = {
    // In development, be more tolerant of APR service failures
    development: {
        allowPartialFailures: true,
        minSuccessfulServices: 1, // At least 1 service must succeed
        criticalServices: ['SwapFeeAprService'], // Only swap fees are critical in dev
        skipExternalServices: true, // Skip external API-dependent services in dev
    },
    // In production, be more strict
    production: {
        allowPartialFailures: true,
        minSuccessfulServices: 3, // At least 3 services must succeed
        criticalServices: ['SwapFeeAprService', 'BoostedPoolAprService', 'GaugeAprService'],
        skipExternalServices: false,
    },
};

const getAprConfig = () => {
    return isDevelopment || isCI ? APR_CONFIG.development : APR_CONFIG.production;
};

export class PoolAprUpdaterService {
    constructor() {}

    private getAprServices(chain: string): PoolAprService[] {
        const chainId = chainToChainId[chain];
        return AllNetworkConfigs[chainId]?.poolAprServices ?? [];
    }

    async updatePoolAprs(chain: Chain) {
        const pools = await prisma.prismaPool.findMany({
            ...poolsIncludeForAprs,
            where: { chain: chain },
        });

        await this.updateAprsForPools(pools);
    }

    async reloadAllPoolAprs(chain: Chain) {
        await prisma.prismaPoolAprRange.deleteMany({ where: { chain: chain } });
        await prisma.prismaPoolAprItem.deleteMany({ where: { chain: chain } });
        await this.updatePoolAprs(chain);
    }

    async updateAprsForPools(pools: PoolForAPRs[]) {
        const aprServices = pools.length ? this.getAprServices(pools[0].chain) : [];

        const config = getAprConfig();
        const failedAprServices = [];
        const successfulServices = [];
        const skippedServices = [];

        console.log(`🔄 Starting APR update for ${aprServices.length} services...`);
        console.log(`⚙️  Environment: ${isDevelopment ? 'development' : 'production'}, Config:`, config);

        for (const aprService of aprServices) {
            const serviceName = aprService.getAprServiceName();

            // Skip external services in development if configured
            if (config.skipExternalServices && this.isExternalService(serviceName)) {
                console.log(`⏭️  Skipping external service in development: ${serviceName}`);
                skippedServices.push(serviceName);
                continue;
            }

            try {
                console.log(`📊 Updating APR for service: ${serviceName}`);
                await aprService.updateAprForPools(pools);
                successfulServices.push(serviceName);
                console.log(`✅ Successfully updated APR for service: ${serviceName}`);
            } catch (e) {
                console.error(`❌ Error during APR update for ${serviceName}:`, {
                    serviceName,
                    error: e instanceof Error ? e.message : String(e),
                    stack: e instanceof Error ? e.stack : undefined,
                    timestamp: new Date().toISOString(),
                });
                failedAprServices.push(serviceName);
            }
        }

        console.log(`📊 APR Update Summary:`, {
            successful: successfulServices.length,
            failed: failedAprServices.length,
            skipped: skippedServices.length,
            successfulServices,
            failedServices: failedAprServices,
            skippedServices,
            environment: isDevelopment ? 'development' : 'production',
        });

        // Check if we have enough successful services
        const hasMinSuccessful = successfulServices.length >= config.minSuccessfulServices;
        const failedCriticalServices = failedAprServices.filter((service) => config.criticalServices.includes(service));
        const allServicesFailed = failedAprServices.length === aprServices.length - skippedServices.length;
        const criticalServicesFailed = failedCriticalServices.length > 0;

        // Decision logic based on environment
        if (allServicesFailed) {
            throw new Error(`🚨 Critical: ALL available APR services failed: ${failedAprServices.join(', ')}`);
        }

        if (!hasMinSuccessful) {
            throw new Error(
                `🚨 Critical: Only ${successfulServices.length} services succeeded, minimum required: ${config.minSuccessfulServices}`,
            );
        }

        if (criticalServicesFailed && !config.allowPartialFailures) {
            throw new Error(`🚨 Critical: Essential APR services failed: ${failedCriticalServices.join(', ')}`);
        }

        // If we're in development or have enough successful services, continue with warnings
        if (failedAprServices.length > 0) {
            const message = `⚠️  Some APR services failed but continuing with ${
                successfulServices.length
            } successful services. Failed: ${failedAprServices.join(', ')}`;
            if (criticalServicesFailed) {
                console.warn(`🟨 ${message} (includes critical services: ${failedCriticalServices.join(', ')})`);
            } else {
                console.warn(message);
            }
        }

        await this.updateTotalApr(pools);

        console.log(
            `✅ APR update completed successfully with ${successfulServices.length}/${
                aprServices.length - skippedServices.length
            } available services`,
        );
    }

    private isExternalService(serviceName: string): boolean {
        // Services that depend on external APIs
        const externalServices = [
            'VeBalVotingAprService',
            'ProtocolAprService',
            'AaveApiAprService',
            'MorphoRewardsAprService',
        ];
        return externalServices.includes(serviceName);
    }

    private async updateTotalApr(pools: PoolForAPRs[]) {
        if (pools.length === 0) {
            return;
        }
        const items = await prisma.prismaPoolAprItem.findMany({
            where: {
                chain: pools[0].chain,
                ...(pools.length > 10 ? {} : { poolId: { in: pools.map((p) => p.id) } }),
                type: {
                    notIn: [
                        'SURPLUS',
                        'SURPLUS_30D',
                        'SURPLUS_7D',
                        'SWAP_FEE_30D',
                        'SWAP_FEE_7D',
                        'DYNAMIC_SWAP_FEE_24H',
                    ],
                },
            },
        });

        const grouped = _.groupBy(items, 'poolId');
        let operations: any[] = [];

        // Select / update aprs in Dynamic Data
        const dynamicData = _.keyBy(
            pools.map((pool) => pool.dynamicData),
            'poolId',
        );

        //store the total APR on the dynamic data so we can sort by it
        for (const poolId in grouped) {
            const apr = _.sumBy(grouped[poolId], (item) => item.apr);
            if (dynamicData[poolId]?.apr !== apr && dynamicData[poolId]?.chain) {
                operations.push(
                    prisma.prismaPoolDynamicData.update({
                        where: { id_chain: { id: poolId, chain: dynamicData[poolId].chain } },
                        data: { apr },
                    }),
                );
            }
        }

        await prismaBulkExecuteOperations(operations);
    }
}
