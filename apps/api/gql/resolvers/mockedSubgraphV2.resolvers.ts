// Type definitions for Balancer V2 subgraph entities
export interface Balancer {
    id: string;
    poolCount: number;
    totalLiquidity: string;
    totalSwapCount: string;
    totalSwapVolume: string;
    totalSwapFee: string;
    totalProtocolFee?: string;
    protocolFeesCollector?: string;
}

export interface Pool {
    id: string;
    address: string;
    poolType?: string;
    poolTypeVersion?: number;
    factory?: string;
    strategyType: number;
    oracleEnabled: boolean;
    symbol?: string;
    name?: string;
    swapEnabled: boolean;
    swapEnabledInternal?: boolean;
    swapEnabledCurationSignal?: boolean;
    swapFee: string;
    owner?: string;
    isPaused?: boolean;
    totalWeight?: string;
    totalSwapVolume: string;
    totalSwapFee: string;
    totalLiquidity: string;
    totalLiquiditySansBPT?: string;
    totalShares: string;
    totalProtocolFee?: string;
    createTime: number;
    swapsCount: string;
    holdersCount: number;
    tx?: string;
    tokensList: string[];
    // Pool-specific fields
    amp?: string;
    principalToken?: string;
    baseToken?: string;
    expiryTime?: string;
    unitSeconds?: string;
    managementFee?: string;
    joinExitEnabled?: boolean;
    mustAllowlistLPs?: boolean;
    managementAumFee?: string;
    totalAumFeeCollectedInBPT?: string;
    mainIndex?: number;
    wrappedIndex?: number;
    lowerTarget?: string;
    upperTarget?: string;
    sqrtAlpha?: string;
    sqrtBeta?: string;
    root3Alpha?: string;
    c?: string;
    s?: string;
    tauAlphaX?: string;
    tauAlphaY?: string;
    tauBetaX?: string;
    tauBetaY?: string;
    u?: string;
    v?: string;
    w?: string;
    z?: string;
    dSq?: string;
    alpha?: string;
    beta?: string;
    lambda?: string;
    delta?: string;
    epsilon?: string;
    quoteToken?: string;
    protocolPercentFee?: number;
    isInRecoveryMode?: boolean;
    protocolSwapFeeCache?: string;
    protocolYieldFeeCache?: string;
    protocolAumFeeCache?: string;
    totalProtocolFeePaidInBPT?: string;
    lastJoinExitAmp?: string;
    lastPostJoinExitInvariant?: string;
    protocolId?: number;
}

export interface Token {
    id: string;
    symbol?: string;
    name?: string;
    decimals: number;
    address: string;
    totalBalanceUSD: string;
    totalBalanceNotional: string;
    totalVolumeUSD: string;
    totalVolumeNotional: string;
    totalSwapCount: string;
    latestUSDPrice?: string;
    latestUSDPriceTimestamp?: string;
    latestFXPrice?: string;
    fxOracleDecimals?: number;
}

export interface User {
    id: string;
}

export interface Swap {
    id: string;
    caller: string;
    tokenIn: string;
    tokenInSym: string;
    tokenOut: string;
    tokenOutSym: string;
    tokenAmountIn: string;
    tokenAmountOut: string;
    valueUSD: string;
    timestamp: number;
    block?: string;
    tx: string;
}

export interface JoinExit {
    id: string;
    type: 'Join' | 'Exit';
    sender: string;
    amounts: string[];
    valueUSD?: string;
    timestamp: number;
    tx: string;
    block?: string;
}

export interface PoolShare {
    id: string;
    balance: string;
}

export interface PoolToken {
    id: string;
    assetManager: string;
    symbol: string;
    name: string;
    decimals: number;
    index?: number;
    address: string;
    oldPriceRate?: string;
    priceRate: string;
    balance: string;
    paidProtocolFees?: string;
    cashBalance: string;
    managedBalance: string;
    weight?: string;
    isExemptFromYieldProtocolFee?: boolean;
}

export interface PriceRateProvider {
    id: string;
    address: string;
    rate?: string;
    lastCached?: number;
    cacheDuration?: number;
    cacheExpiry?: number;
}

export interface CircuitBreaker {
    id: string;
    bptPrice: string;
    lowerBoundPercentage: string;
    upperBoundPercentage: string;
}

export interface GradualWeightUpdate {
    id: string;
    scheduledTimestamp: number;
    startTimestamp: string;
    endTimestamp: string;
    startWeights: string[];
    endWeights: string[];
}

export interface AmpUpdate {
    id: string;
    scheduledTimestamp: number;
    startTimestamp: string;
    endTimestamp: string;
    startAmp: string;
    endAmp: string;
}

export interface SwapFeeUpdate {
    id: string;
    scheduledTimestamp: number;
    startTimestamp: string;
    endTimestamp: string;
    startSwapFeePercentage: string;
    endSwapFeePercentage: string;
}

export interface LatestPrice {
    id: string;
    asset: string;
    pricingAsset: string;
    price: string;
    block: string;
}

export interface PoolHistoricalLiquidity {
    id: string;
    poolTotalShares: string;
    poolLiquidity: string;
    poolShareValue: string;
    pricingAsset: string;
    block: string;
}

export interface TokenPrice {
    id: string;
    asset: string;
    amount: string;
    pricingAsset: string;
    price: string;
    block: string;
    timestamp: number;
}

export interface ManagementOperation {
    id: string;
    type: 'Deposit' | 'Withdraw' | 'Update';
    cashDelta: string;
    managedDelta: string;
    timestamp: number;
}

export interface PoolSnapshot {
    id: string;
    amounts: string[];
    totalShares: string;
    swapVolume: string;
    protocolFee?: string;
    swapFees: string;
    liquidity: string;
    swapsCount: string;
    holdersCount: number;
    timestamp: number;
}

export interface TokenSnapshot {
    id: string;
    timestamp: number;
    totalBalanceUSD: string;
    totalBalanceNotional: string;
    totalVolumeUSD: string;
    totalVolumeNotional: string;
    totalSwapCount: string;
}

export interface TradePair {
    id: string;
    totalSwapVolume: string;
    totalSwapFee: string;
}

export interface TradePairSnapshot {
    id: string;
    timestamp: number;
    totalSwapVolume: string;
    totalSwapFee: string;
}

export interface BalancerSnapshot {
    id: string;
    timestamp: number;
    poolCount: number;
    totalLiquidity: string;
    totalSwapCount: string;
    totalSwapVolume: string;
    totalSwapFee: string;
    totalProtocolFee?: string;
}

export interface ProtocolIdData {
    id: string;
    name: string;
}

export interface FXOracle {
    id: string;
    tokens: string[];
    divisor?: string;
    decimals?: number;
}

export interface FXPoolDeployer {
    id: string;
    quoteToken: string;
}

export interface PoolContract {
    id: string;
}

// Query resolver type definitions
export interface QueryResolvers {
    balancers: () => Balancer[];
    pools: () => Pool[];
    tokens: () => Token[];
    users: () => User[];
    swaps: () => Swap[];
    joinExits: () => JoinExit[];
    poolShares: () => PoolShare[];
    poolTokens: () => PoolToken[];
    priceRateProviders: () => PriceRateProvider[];
    circuitBreakers: () => CircuitBreaker[];
    gradualWeightUpdates: () => GradualWeightUpdate[];
    ampUpdates: () => AmpUpdate[];
    swapFeeUpdates: () => SwapFeeUpdate[];
    latestPrices: () => LatestPrice[];
    poolHistoricalLiquidities: () => PoolHistoricalLiquidity[];
    tokenPrices: () => TokenPrice[];
    managementOperations: () => ManagementOperation[];
    poolSnapshots: () => PoolSnapshot[];
    tokenSnapshots: () => TokenSnapshot[];
    tradePairs: () => TradePair[];
    tradePairSnapshots: () => TradePairSnapshot[];
    balancerSnapshots: () => BalancerSnapshot[];
    protocolIdData: () => ProtocolIdData[];
    fxOracles: () => FXOracle[];
    fxPoolDeployers: () => FXPoolDeployer[];
    poolContracts: () => PoolContract[];
}

// Resolvers implementation
const mockedSubgraphV2Resolvers: { Query: QueryResolvers } = {
    Query: {
        balancers: () => [],
        pools: () => [],
        tokens: () => [],
        users: () => [],
        swaps: () => [],
        joinExits: () => [],
        poolShares: () => [],
        poolTokens: () => [],
        priceRateProviders: () => [],
        circuitBreakers: () => [],
        gradualWeightUpdates: () => [],
        ampUpdates: () => [],
        swapFeeUpdates: () => [],
        latestPrices: () => [],
        poolHistoricalLiquidities: () => [],
        tokenPrices: () => [],
        managementOperations: () => [],
        poolSnapshots: () => [],
        tokenSnapshots: () => [],
        tradePairs: () => [],
        tradePairSnapshots: () => [],
        balancerSnapshots: () => [],
        protocolIdData: () => [],
        fxOracles: () => [],
        fxPoolDeployers: () => [],
        poolContracts: () => [],
    },
};

export default mockedSubgraphV2Resolvers;
