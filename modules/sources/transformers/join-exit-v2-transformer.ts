import _ from 'lodash';
import { BalancerJoinExitFragment } from '../../subgraphs/balancer-subgraph/generated/balancer-subgraph-types';
import { Chain, PoolEventType } from '@prisma/client';
import { JoinExitEvent } from '../../../prisma/prisma-types';
import { getViemClient } from '../viem-client';
import { parseAbiItem } from 'abitype';
import { decodeEventLog } from 'viem';
import { vaultV2Abi } from '@balancer/sdk';
import config from '../../../config';

/**
 * Takes V3 subgraph swaps and transforms them into DB entries
 *
 * @param swaps
 * @param chain
 * @returns
 */
export async function joinExitV2Transformer(
    events: BalancerJoinExitFragment[],
    chain: Chain,
): Promise<JoinExitEvent[]> {
    const protocolVersion = 2;

    return Promise.all(
        events.map(async (event) => {
            // Kassandra pools event amounts aren't matching with the pool.tokenList addresses
            // This is a temporary fix to avoid the error, but eventually, we should fix the root cause in the subgraph
            let tokens: { address: string; amount: string; valueUSD: number }[] = [];
            if (event.pool.tokensList.length !== event.amounts.length && event.block) {
                // Get the event from RPC
                const viemClient = getViemClient(chain);
                const vaultAddress = config[chain]?.balancer?.v2?.vaultAddress as `0x${string}` | undefined;
                if (!vaultAddress) {
                    // Chain not configured for V2 vault; skip this event
                    return null;
                }

                let logs: any[] = [];
                let attempt = 0;
                const maxAttempts = 3;
                while (attempt < maxAttempts) {
                    try {
                        logs = await viemClient.getLogs({
                            address: vaultAddress,
                            event: parseAbiItem(
                                'event PoolBalanceChanged(bytes32 poolId, address liquidityProvider, address[] tokens, int256[] deltas, uint256[] protocolFeeAmounts)',
                            ),
                            fromBlock: BigInt(event.block),
                            toBlock: BigInt(event.block),
                        });
                        break;
                    } catch (error: any) {
                        attempt += 1;
                        const msg = String(error?.message || error?.shortMessage || '');
                        const retriable =
                            msg.includes('neither result nor error') || msg.includes('RPC Request failed');
                        if (!retriable || attempt >= maxAttempts) {
                            // Skip this event on persistent RPC failure
                            return null;
                        }
                        await new Promise((r) => setTimeout(r, 250 * attempt));
                    }
                }
                const log = logs.find(
                    (log) => log.transactionHash === event.tx && log.logIndex === Number(event.id.substring(66)),
                );
                // Just a precaution
                if (!log) {
                    return null;
                }
                const parsed = decodeEventLog({
                    abi: [
                        parseAbiItem(
                            'event PoolBalanceChanged(bytes32 indexed poolId, address indexed liquidityProvider, address[] tokens, int256[] deltas, uint256[] protocolFeeAmounts)',
                        ),
                    ],
                    data: log.data,
                    topics: log.topics,
                });
                tokens = parsed.args.tokens.map((address, i) => ({
                    address,
                    amount: parsed.args.deltas[i].toString(),
                    valueUSD: 0,
                }));
            } else {
                tokens = event.pool.tokensList.map((token, i) => ({
                    address: token,
                    amount: event.amounts[i],
                    valueUSD: 0,
                }));
            }
            return {
                protocolVersion,
                id: event.id, // tx + logIndex
                tx: event.tx,
                type: event.type === 'Join' ? PoolEventType.JOIN : PoolEventType.EXIT,
                poolId: event.pool.id,
                chain: chain,
                userAddress: event.sender,
                blockNumber: Number(event.block ?? 0),
                blockTimestamp: Number(event.timestamp),
                logIndex: Number(event.id.substring(66)),
                valueUSD: 0,
                payload: {
                    tokens,
                },
            };
        }),
    ).then((events) => events.filter((event) => event !== null)) as Promise<JoinExitEvent[]>;
}
