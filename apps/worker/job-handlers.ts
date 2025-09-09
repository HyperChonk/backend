import { Chain } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { Express, NextFunction } from 'express';
import moment from 'moment';
import config from '../../config';
import { updateVolumeAndFees } from '../../modules/actions/pool/update-volume-and-fees';
import { initRequestScopedContext, setRequestScopedContextValue } from '../../modules/context/request-scoped-context';
import {
    AprsController,
    ContentController,
    CowAmmController,
    EventController,
    PoolController,
    QuantAmmController,
    SftmxController,
    SnapshotsController,
    StakedSonicController,
    StakingController,
    UserBalancesController,
} from '../../modules/controllers';
import { LBPController } from '../../modules/controllers/lbp-controller';
import { SubgraphMonitorController } from '../../modules/controllers/subgraph-monitor-controller';
import { TokenController } from '../../modules/controllers/token-controller';
import { datastudioService } from '../../modules/datastudio/datastudio.service';
import { cronsDurationMetricPublisher } from '../../modules/metrics/cron-duration-metrics.client';
import { cronsMetricPublisher } from '../../modules/metrics/metrics.client';
import { chainIdToChain } from '../../modules/network/chain-id-to-chain';
import { networkContext } from '../../modules/network/network-context.service';
import { isChainWhitelisted } from '../../modules/network/whitelisted-chains';
import { poolService } from '../../modules/pool/pool.service';
import { protocolService } from '../../modules/protocol/protocol.service';
import { syncLatestFXPrices } from '../../modules/token/latest-fx-price';
import { tokenService } from '../../modules/token/token.service';
import { userService } from '../../modules/user/user.service';
import { veBalVotingListService } from '../../modules/vebal/vebal-voting-list.service';
import { veBalService } from '../../modules/vebal/vebal.service';

const runningJobs: Set<string> = new Set();

async function runIfNotAlreadyRunning(
    id: string,
    chainId: string,
    fn: () => any,
    res: any,
    next: NextFunction,
): Promise<void> {
    const jobId = `${id}-${chainId}`;

    console.log(`Current jobqueue length: ${runningJobs.size}`);

    if (runningJobs.has(jobId)) {
        if (process.env.AWS_ALERTS === 'true') {
            await cronsMetricPublisher.publish(`${jobId}-skip`);
        }
        console.log(`Skip job ${jobId}-skip`);
        res.sendStatus(200);
        return;
    }

    const startJobTime = moment();

    try {
        runningJobs.add(jobId);

        console.log(`Start job ${jobId}-start`);

        await fn();

        const durationSuccess = moment.duration(moment().diff(startJobTime)).asSeconds();
        if (process.env.AWS_ALERTS === 'true') {
            await cronsMetricPublisher.publish(`${jobId}-done`);
            await cronsDurationMetricPublisher.publish(`${jobId}-done`, durationSuccess);
        }
        console.log(`Successful job ${jobId}-done`, durationSuccess);
    } catch (error: any) {
        const durationError = moment.duration(moment().diff(startJobTime)).asSeconds();
        if (process.env.AWS_ALERTS === 'true') {
            await cronsMetricPublisher.publish(`${jobId}-error`);
            await cronsDurationMetricPublisher.publish(`${jobId}-error`, durationError);
        }
        const duration = moment.duration(moment().diff(startJobTime)).asSeconds();
        console.log(`Error job ${jobId}-error`, duration, error.message || error);
        // If DB connection pool is exhausted, don't crash the worker; acknowledge and continue
        if (error?.code === 'P2037' || /remaining connection slots/i.test(String(error?.message))) {
            console.warn(`Non-fatal DB connection exhaustion for ${jobId}. Marking job as done to recover.`);
            res.sendStatus(200);
        } else {
            next(error);
        }
    } finally {
        runningJobs.delete(jobId);
        res.sendStatus(200);
    }
}

export function configureWorkerRoutes(app: Express) {
    app.post('/', async (req, res, next) => {
        Sentry.withIsolationScope(async (scope) => {
            const job = req.body as { name: string; chain: string };
            const sentryTransactionName = `${job.name}-${job.chain}`;

            // Clear breadcrumbs to avoid mixing them between requests
            // That doesn't always work, but it's better than nothing
            scope.clearBreadcrumbs();
            scope.setTransactionName(sentryTransactionName);
            scope.setTag('job', job.name);
            scope.setTag('chain', job.chain);

            initRequestScopedContext();
            setRequestScopedContextValue('chainId', job.chain);

            // Start profiling span for the job
            Sentry.startSpan({ op: 'job', name: sentryTransactionName }, () => {
                setupJobHandlers(job.name, job.chain, res, next);
            });
        });
    });
}

export const setupJobHandlers = async (name: string, chainId: string, res: any, next: NextFunction) => {
    // Safety check: ensure the chain is whitelisted before processing
    if (!isChainWhitelisted(chainId)) {
        console.warn(`WORKER: Received job for non-whitelisted chain ${chainId}. Skipping.`);
        res.sendStatus(200); // Acknowledge the message to remove it from the queue
        return;
    }

    // Ensure request-scoped context is initialized for all jobs so networkContext sees the active chain
    initRequestScopedContext();
    setRequestScopedContextValue('chainId', chainId);

    const chain = chainIdToChain[chainId];
    switch (name) {
        case 'sync-changed-pools':
            await runIfNotAlreadyRunning(name, chainId, () => PoolController().syncChangedPoolsV2(chain), res, next);
            break;
        case 'user-sync-wallet-balances-for-all-pools':
            await runIfNotAlreadyRunning(name, chainId, () => UserBalancesController().syncBalances(chain), res, next);
            break;
        case 'user-sync-staked-balances':
            await runIfNotAlreadyRunning(name, chainId, () => userService.syncChangedStakedBalances(chain), res, next);
            break;
        case 'update-token-prices':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => tokenService.updateTokenPrices(Object.keys(config) as Chain[]),
                res,
                next,
            );
            break;
        case 'update-liquidity-for-inactive-pools':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => PoolController().updateLiquidityValuesForInactivePools(chain),
                res,
                next,
            );
            break;
        case 'load-on-chain-data-for-pools-with-active-updates':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => {
                    return poolService.loadOnChainDataForPoolsWithActiveUpdates();
                },
                res,
                next,
            );
            break;
        case 'sync-new-pools-from-subgraph':
            await runIfNotAlreadyRunning(name, chainId, () => PoolController().addPoolsV2(chain), res, next);
            break;
        case 'sync-join-exits-v2':
            await runIfNotAlreadyRunning(name, chainId, () => EventController().syncJoinExitsV2(chain), res, next);
            break;
        case 'sync-tokens-from-pool-tokens':
            await runIfNotAlreadyRunning(name, chainId, () => tokenService.syncTokenContentData(chain), res, next);
            break;
        case 'update-liquidity-24h-ago-v2':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => PoolController().updateLiquidity24hAgoV2(chain),
                res,
                next,
            );
            break;
        case 'sync-staking-for-pools':
            await runIfNotAlreadyRunning(name, chainId, () => StakingController().syncStaking(chain), res, next);
            break;
        case 'cache-protocol-data':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => protocolService.cacheProtocolMetrics(networkContext.chain),
                res,
                next,
            );
            break;
        case 'sync-snapshots-v2':
            await runIfNotAlreadyRunning(name, chainId, () => SnapshotsController().syncSnapshotsV2(chain), res, next);
            break;
        case 'sync-snapshots-v3':
            await runIfNotAlreadyRunning(name, chainId, () => SnapshotsController().syncSnapshotsV3(chain), res, next);
            break;
        case 'forward-fill-snapshots-v3':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => {
                    // Run just once per 24h
                    const now = new Date();
                    if (now.getUTCHours() !== 0) {
                        return true;
                    }
                    return SnapshotsController().forwardFillSnapshotsForPoolsWithoutUpdatesV3(chain);
                },
                res,
                next,
            );
            break;
        case 'feed-data-to-datastudio':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => {
                    return datastudioService.feedPoolData(chain);
                },
                res,
                next,
            );
            break;
        case 'sync-latest-reliquary-snapshots':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => poolService.syncLatestReliquarySnapshotsForAllFarms(chain),
                res,
                next,
            );
            break;
        case 'global-purge-old-tokenprices':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => tokenService.purgeOldTokenPricesForAllChains(),
                res,
                next,
            );
            break;
        case 'update-fee-volume-yield-all-pools':
            await runIfNotAlreadyRunning(name, chainId, () => updateVolumeAndFees(chain), res, next);
            break;
        case 'sync-vebal-balances':
            await runIfNotAlreadyRunning(name, chainId, () => veBalService.syncVeBalBalances(), res, next);
            break;
        case 'sync-vebal-snapshots':
            await runIfNotAlreadyRunning(name, chainId, () => veBalService.syncVeBalUserBalanceSnapshots(), res, next);
            break;
        case 'sync-vebal-totalSupply':
            await runIfNotAlreadyRunning(name, chainId, () => veBalService.syncVeBalTotalSupply(), res, next);
            break;
        case 'sync-vebal-voting-gauges':
            await runIfNotAlreadyRunning(name, chainId, () => veBalVotingListService.syncVotingGauges(), res, next);
            break;
        case 'sync-latest-fx-prices':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => {
                    const subgraphUrl = config[chain].subgraphs.balancer;
                    return syncLatestFXPrices(subgraphUrl, chain);
                },
                res,
                next,
            );
            break;
        case 'sync-sts-staking-data':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => StakedSonicController().syncSonicStakingData(),
                res,
                next,
            );
            break;
        case 'sync-sts-staking-snapshots':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => StakedSonicController().syncSonicStakingSnapshots(),
                res,
                next,
            );
            break;
        case 'sync-sftmx-staking-data':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => {
                    const sftmxController = SftmxController();
                    return sftmxController.syncSftmxStakingData(chainId);
                },
                res,
                next,
            );
            break;
        case 'sync-sftmx-withdrawal-requests':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => {
                    const sftmxController = SftmxController();
                    return sftmxController.syncSftmxWithdrawalrequests(chainId);
                },
                res,
                next,
            );
            break;
        case 'sync-sftmx-staking-snapshots':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => {
                    const sftmxController = SftmxController();
                    return sftmxController.syncSftmxStakingSnapshots(chainId);
                },
                res,
                next,
            );
            break;
        // APRs
        case 'sync-merkl':
            await runIfNotAlreadyRunning(name, chainId, () => AprsController().syncMerkl(), res, next);
            break;
        case 'update-7-30-days-swap-apr':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => AprsController().update7And30DaysSwapAprs(chain),
                res,
                next,
            );
            break;
        case 'update-surplus-aprs':
            await runIfNotAlreadyRunning(name, chainId, () => CowAmmController().updateSurplusAprs(), res, next);
            break;
        case 'update-pool-apr':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => {
                    const chain = chainIdToChain[chainId];
                    return poolService.updatePoolAprs(chain);
                },
                res,
                next,
            );
            break;
        // V3 Jobs
        case 'add-pools-v3':
            await runIfNotAlreadyRunning(name, chainId, () => PoolController().addPoolsV3(chain), res, next);
            break;
        case 'sync-pools-v3':
            await runIfNotAlreadyRunning(name, chainId, () => PoolController().syncPoolsV3(chain), res, next);
            break;
        case 'sync-hook-data':
            await runIfNotAlreadyRunning(name, chainId, () => PoolController().syncHookData(chain), res, next);
            break;
        case 'sync-swaps-v3':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => EventController().syncSwapsUpdateVolumeAndFeesV3(chain),
                res,
                next,
            );
            break;
        case 'sync-swaps-v2':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => EventController().syncSwapsUpdateVolumeAndFeesV2(chain),
                res,
                next,
            );
            break;
        case 'sync-join-exits-v3':
            await runIfNotAlreadyRunning(name, chainId, () => EventController().syncJoinExitsV3(chain), res, next);
            break;
        case 'update-liquidity-24h-ago-v3':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => PoolController().updateLiquidity24hAgoV3(chain),
                res,
                next,
            );
            break;
        // COW AMM
        case 'sync-cow-amm-pools':
            await runIfNotAlreadyRunning(name, chainId, () => CowAmmController().syncPools(chain), res, next);
            break;
        case 'sync-cow-amm-swaps':
            await runIfNotAlreadyRunning(name, chainId, () => CowAmmController().syncSwaps(chain), res, next);
            break;
        case 'sync-cow-amm-join-exits':
            await runIfNotAlreadyRunning(name, chainId, () => CowAmmController().syncJoinExits(chain), res, next);
            break;
        case 'sync-cow-amm-snapshots':
            await runIfNotAlreadyRunning(name, chainId, () => CowAmmController().syncSnapshots(chain), res, next);
            break;
        case 'sync-categories':
            await runIfNotAlreadyRunning(name, chainId, () => ContentController().syncCategories(), res, next);
            break;
        case 'sync-rate-provider-reviews':
            await runIfNotAlreadyRunning(name, chainId, () => ContentController().syncRateProviderReviews(), res, next);
            break;
        case 'sync-hook-reviews':
            await runIfNotAlreadyRunning(name, chainId, () => ContentController().syncHookReviews(), res, next);
            break;
        case 'sync-erc4626-data':
            await runIfNotAlreadyRunning(name, chainId, () => ContentController().syncErc4626Data(), res, next);
            break;
        case 'sync-erc4626-unwrap-rate':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => TokenController().syncErc4626UnwrapRates(chain),
                res,
                next,
            );
            break;
        case 'post-subgraph-lag-metrics':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => SubgraphMonitorController().postSubgraphLagMetrics(),
                res,
                next,
            );
            break;
        case 'sync-weights':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => Promise.all([QuantAmmController.syncWeights(chain), LBPController.syncWeights(chain)]),
                res,
                next,
            );
            break;
        case 'reload-erc4626-tokens':
            await runIfNotAlreadyRunning(name, chainId, () => TokenController().syncErc4626Tokens(chain), res, next);
            break;
        case 'reload-all-token-types':
            await runIfNotAlreadyRunning(name, chainId, () => tokenService.reloadAllTokenTypes(chain), res, next);
            break;
        default:
            res.sendStatus(400);
            // throw new Error(`Unhandled job type ${name}`);
            console.log(`Unhandled job type ${name}`);
    }
};
