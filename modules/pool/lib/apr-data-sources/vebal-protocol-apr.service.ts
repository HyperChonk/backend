import { PoolAprService } from '../../pool-types';
import { PoolForAPRs } from '../../../../prisma/prisma-types';
import { prisma } from '../../../../prisma/prisma-client';
import { multicallViem } from '../../../web3/multicaller-viem';
import { mainnet } from 'viem/chains';
import { createPublicClient, formatUnits, http, parseAbi } from 'viem';

const feeDistributorAbi = parseAbi([
    'function getTokensDistributedInWeek(address token, uint timestamp) view returns (uint)',
    'function claimTokens(address user, address[] tokens) returns (uint256[])',
    'function claimToken(address user, address token) returns (uint256)',
]);

const veBalAbi = parseAbi(['function totalSupply() view returns (uint)']);

const feeDistributorAddress = '0xd3cf852898b21fc233251427c2dc93d3d604f3bb';
const balAddress = '0xba100000625a3754423978a60c9317c58a424e3d';
const vebalPool = '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014';
const vebalPoolAddress = '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56';
const vebalAddress = '0xc128a9954e6c874ea3d62ce62b468ba073093f25';
const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const id = `${vebalPool}-protocol-apr`;
const chain = 'MAINNET';

const getPreviousWeek = (fromJSTimestamp: number): number => {
    const weeksToGoBack = 1;
    const midnight = new Date(Math.floor(fromJSTimestamp));
    midnight.setUTCHours(0);
    midnight.setUTCMinutes(0);
    midnight.setUTCSeconds(0);
    midnight.setUTCMilliseconds(0);

    let daysSinceThursday = midnight.getUTCDay() - 4;
    if (daysSinceThursday < 0) daysSinceThursday += 7;

    daysSinceThursday = daysSinceThursday + weeksToGoBack * 7;

    return Math.floor(midnight.getTime() / 1000) - daysSinceThursday * 86400;
};

const fetchRevenue = async (timestamp: number, rpcUrl: string, retries = 3) => {
    const previousWeek = getPreviousWeek(timestamp);
    
    console.log(`🔄 Fetching revenue data for week: ${previousWeek} (${new Date(previousWeek * 1000).toISOString()})`);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`📡 RPC call attempt ${attempt}/${retries} to: ${rpcUrl}`);
            
            const viemClient = createPublicClient({
                chain: mainnet,
                transport: http(rpcUrl, {
                    timeout: 15000, // 15 second timeout
                    retryCount: 2,
                }),
            });

            const results = await multicallViem(viemClient, [
                {
                    path: 'balAmount',
                    address: feeDistributorAddress,
                    abi: feeDistributorAbi,
                    functionName: 'getTokensDistributedInWeek',
                    args: [balAddress, previousWeek],
                },
                {
                    path: 'usdcAmount',
                    address: feeDistributorAddress,
                    abi: feeDistributorAbi,
                    functionName: 'getTokensDistributedInWeek',
                    args: [usdcAddress, previousWeek],
                },
                {
                    path: 'veBalSupply',
                    address: vebalAddress,
                    abi: veBalAbi,
                    functionName: 'totalSupply',
                },
            ]);

            // Validate results
            if (!results || typeof results !== 'object') {
                throw new Error('Invalid multicall results');
            }

            const data = {
                balAmount: results.balAmount ? parseFloat(formatUnits(results.balAmount, 18)) : 0,
                usdcAmount: results.usdcAmount ? parseFloat(formatUnits(results.usdcAmount, 6)) : 0,
                veBalSupply: results.veBalSupply ? parseFloat(formatUnits(results.veBalSupply, 18)) : 0,
                usdcPrice: parseFloat('1.0'),
                balAddress: balAddress,
            };

            // Validate data
            if (!Number.isFinite(data.balAmount) || !Number.isFinite(data.usdcAmount) || !Number.isFinite(data.veBalSupply)) {
                throw new Error(`Invalid revenue data: ${JSON.stringify(data)}`);
            }

            if (data.veBalSupply <= 0) {
                throw new Error(`Invalid veBAL supply: ${data.veBalSupply}`);
            }

            console.log(`✅ Successfully fetched revenue data:`, data);
            return data;
            
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`❌ Revenue fetch attempt ${attempt} failed:`, errorMessage);
            
            if (attempt === retries) {
                throw new Error(`Failed to fetch revenue data after ${retries} attempts. Last error: ${errorMessage}`);
            }
            
            // Wait before retry
            const waitTime = attempt * 2000; // 2s, 4s, 6s
            console.log(`⏳ Waiting ${waitTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
    
    throw new Error('Unexpected error in fetchRevenue');
};

export class VeBalProtocolAprService implements PoolAprService {
    constructor(private rpcUrl: string) {}

    public getAprServiceName(): string {
        return 'ProtocolAprService';
    }

    async getApr(): Promise<number> {
        try {
            console.log(`🔄 Starting VeBalProtocolAprService APR calculation...`);
            
            const revenue = await fetchRevenue(Date.now(), this.rpcUrl);

            console.log(`🔍 Fetching token prices...`);
            
            // Fetch prices with error handling
            const [balPrice, usdcPrice, bptPrice] = await Promise.all([
                prisma.prismaTokenCurrentPrice.findFirst({
                    where: { tokenAddress: balAddress, chain: 'MAINNET' },
                    select: { price: true },
                }),
                prisma.prismaTokenCurrentPrice.findFirst({
                    where: { tokenAddress: usdcAddress, chain: 'MAINNET' },
                    select: { price: true },
                }),
                prisma.prismaTokenCurrentPrice.findFirst({
                    where: { tokenAddress: vebalPoolAddress, chain: 'MAINNET' },
                    select: { price: true },
                }),
            ]);

            // Validate prices
            const missingPrices = [];
            if (!balPrice || !balPrice.price || balPrice.price <= 0) missingPrices.push('BAL');
            if (!usdcPrice || !usdcPrice.price || usdcPrice.price <= 0) missingPrices.push('USDC');
            if (!bptPrice || !bptPrice.price || bptPrice.price <= 0) missingPrices.push('BPT');

            if (missingPrices.length > 0) {
                throw new Error(`Missing or invalid prices for: ${missingPrices.join(', ')}`);
            }

            // Calculate revenue (TypeScript assertions safe due to validation above)
            const lastWeekBalRevenue = revenue.balAmount * balPrice!.price;
            const lastWeekUsdcRevenue = revenue.usdcAmount * usdcPrice!.price;
            const totalWeeklyRevenue = lastWeekBalRevenue + lastWeekUsdcRevenue;
            const dailyRevenue = totalWeeklyRevenue / 7;
            const totalVeBalValue = bptPrice!.price * revenue.veBalSupply;
            const apr = (365 * dailyRevenue) / totalVeBalValue;

            // Validate APR
            if (!Number.isFinite(apr) || apr < 0) {
                throw new Error(`Invalid APR calculated: ${apr}. Daily revenue: ${dailyRevenue}, Total veBAL value: ${totalVeBalValue}`);
            }

            console.log(`📊 VeBalProtocolAprService calculation:`, {
                balAmount: revenue.balAmount.toFixed(2),
                usdcAmount: revenue.usdcAmount.toFixed(2),
                balPrice: balPrice!.price.toFixed(4),
                usdcPrice: usdcPrice!.price.toFixed(4),
                bptPrice: bptPrice!.price.toFixed(4),
                veBalSupply: revenue.veBalSupply.toFixed(2),
                weeklyBalRevenue: lastWeekBalRevenue.toFixed(2),
                weeklyUsdcRevenue: lastWeekUsdcRevenue.toFixed(2),
                totalWeeklyRevenue: totalWeeklyRevenue.toFixed(2),
                dailyRevenue: dailyRevenue.toFixed(2),
                totalVeBalValue: totalVeBalValue.toFixed(2),
                apr: (apr * 100).toFixed(2) + '%',
            });

            return apr;
            
        } catch (error) {
            console.error(`❌ VeBalProtocolAprService failed to calculate APR:`, error);
            throw error;
        }
    }

    async updateAprForPools(pools: PoolForAPRs[]): Promise<void> {
        const apr = await this.getApr();

        await prisma.prismaPoolAprItem.upsert({
            where: { id_chain: { id, chain: 'MAINNET' } },
            create: {
                id,
                chain,
                poolId: vebalPool,
                apr,
                title: 'Protocol APR',
                type: 'LOCKING',
            },
            update: { apr },
        });
    }
}
