# Background Jobs Manual

This document describes the various background jobs that run continuously to keep the Balancer v3 Backend API up-to-date and functional. These jobs are scheduled using cron-like intervals and handle data synchronization, price updates, and system maintenance.

## Core Pool Management Jobs

### `update-liquidity-for-inactive-pools`

-   **Frequency**: Every 10 minutes
-   **Purpose**: Updates liquidity data for pools that haven't seen recent activity. Ensures that even inactive pools maintain accurate TVL (Total Value Locked) information.
-   **Failure Impact**: Inactive pools would show stale liquidity data, affecting portfolio calculations and pool discovery. Users might see incorrect TVL values for less active pools.

### `update-pool-apr`

-   **Frequency**: Every 2 minutes
-   **Purpose**: Calculates and updates Annual Percentage Rate (APR) for all pools based on recent swap fees, rewards, and yield-bearing tokens.
-   **Failure Impact**: Pool APR data becomes stale, leading to incorrect yield projections. Users cannot make informed decisions about which pools offer the best returns.

### `update-7-30-days-swap-apr`

-   **Frequency**: Every 8 hours
-   **Purpose**: Calculates longer-term APR trends (7-day and 30-day averages) to provide historical context for pool performance.
-   **Failure Impact**: Historical APR data stops updating, preventing users from seeing performance trends and making long-term investment decisions.
-   **Difference from `update-pool-apr`**: This job focuses on historical trends while `update-pool-apr` provides real-time snapshots.

### `update-token-prices`

-   **Frequency**: Every 5 minutes
-   **Purpose**: Fetches latest token prices from various price oracles and DEX aggregators to maintain accurate USD valuations.
-   **Failure Impact**: All USD-denominated values become stale (pool TVL, user balances, swap volumes). The entire economic layer of the application becomes unreliable.

### `load-on-chain-data-for-pools-with-active-updates`

-   **Frequency**: Every 1 minute
-   **Purpose**: Prioritizes on-chain data fetching for pools that have recent activity, ensuring the most active pools have the freshest data.
-   **Failure Impact**: Active pools show stale data, degrading user experience for the most important liquidity pools. High-frequency traders and arbitrageurs lose confidence.

### `sync-new-pools-from-subgraph`

-   **Frequency**: Every 2 minutes
-   **Purpose**: Discovers newly created pools from The Graph subgraph and adds them to the database.
-   **Failure Impact**: New pools don't appear in the API, preventing users from discovering and interacting with fresh liquidity opportunities.

### `sync-tokens-from-pool-tokens`

-   **Frequency**: Every 5-10 minutes (varies by environment)
-   **Purpose**: Ensures all tokens referenced by pools are properly tracked in the token registry with correct metadata.
-   **Failure Impact**: New tokens in pools lack proper metadata (symbols, decimals, names), causing display issues and calculation errors.

### `sync-changed-pools`

-   **Frequency**: Every 30 seconds
-   **Purpose**: Detects and processes changes to existing pools (parameter updates, composition changes, etc.).
-   **Failure Impact**: Pool changes aren't reflected in real-time, leading to incorrect swap calculations and outdated pool information.

## User Balance Synchronization

### `user-sync-wallet-balances-for-all-pools`

-   **Frequency**: Every 20 seconds
-   **Purpose**: Updates user wallet balances for pool tokens across all tracked pools.
-   **Failure Impact**: User portfolio data becomes stale, showing incorrect balances and positions. Users cannot track their actual holdings.

### `update-fee-volume-yield-all-pools`

-   **Frequency**: Every 1 hour
-   **Purpose**: Calculates comprehensive fee, volume, and yield metrics across all pools for analytics and reporting.
-   **Failure Impact**: Analytics dashboards show stale data, affecting business intelligence and user insights into pool performance.

## Balancer v3 Specific Jobs

### `add-pools-v3`

-   **Frequency**: Every 30 seconds
-   **Purpose**: Discovers and registers new Balancer v3 pools from on-chain events.
-   **Failure Impact**: New v3 pools don't appear in the system, cutting off access to the latest liquidity opportunities.

### `sync-pools-v3`

-   **Frequency**: Every 30 seconds
-   **Purpose**: Synchronizes state changes for existing v3 pools (balances, weights, parameters).
-   **Failure Impact**: v3 pool data becomes stale, affecting swap routing and liquidity calculations.
-   **Difference from `add-pools-v3`**: This updates existing v3 pools while `add-pools-v3` discovers new ones.

### `sync-join-exits-v3`

-   **Frequency**: Every 1 minute
-   **Purpose**: Processes liquidity provider join/exit events for v3 pools to track LP position changes.
-   **Failure Impact**: LP position tracking becomes inaccurate, affecting portfolio calculations and fee distribution.

### `sync-swaps-v3`

-   **Frequency**: Every 1 minute
-   **Purpose**: Indexes swap transactions on v3 pools for volume tracking and fee calculations.
-   **Failure Impact**: Trading volume data stops updating, affecting APR calculations and pool rankings.
-   **Difference from `sync-join-exits-v3`**: This tracks swaps (trading) while join-exits tracks liquidity provision.

### `update-liquidity-24h-ago-v3`

-   **Frequency**: Every 5 minutes
-   **Purpose**: Maintains historical liquidity snapshots needed for 24-hour change calculations.
-   **Failure Impact**: 24-hour TVL change percentages become inaccurate, affecting trending pool identification.

### `sync-snapshots-v3`

-   **Frequency**: Every 90 minutes
-   **Purpose**: Creates periodic snapshots of v3 pool states for historical analysis and trend calculations.
-   **Failure Impact**: Historical analytics lose data points, preventing long-term trend analysis and reporting.

### `sync-hook-data`

-   **Frequency**: Every 1 hour
-   **Purpose**: Updates data from custom hooks attached to v3 pools (custom logic, additional features).
-   **Failure Impact**: Pools with custom hooks lose their enhanced functionality and additional data feeds.

## Utility and Maintenance Jobs

### `sync-erc4626-unwrap-rate`

-   **Frequency**: Every 20-60 minutes (varies by environment)
-   **Purpose**: Updates unwrap rates for ERC-4626 vault tokens to their underlying assets.
-   **Failure Impact**: Vault token valuations become incorrect, affecting pools that contain yield-bearing vault tokens.

### `sync-weights`

-   **Frequency**: Every 10-60 minutes (varies by environment)
-   **Purpose**: Updates dynamic weights for pools that have time-based or parameter-based weight changes.
-   **Failure Impact**: Pools with dynamic weights show incorrect composition, affecting swap calculations and liquidity provision.
-   **Difference from other sync jobs**: This specifically handles time-sensitive weight changes rather than balance or price updates.

### `reload-erc4626-tokens`

-   **Frequency**: Every 30 minutes
-   **Purpose**: Refreshes the registry of ERC-4626 vault tokens and their current exchange rates.
-   **Failure Impact**: New vault tokens aren't recognized, and existing vault tokens have stale exchange rates.

### `reload-all-token-types`

-   **Frequency**: Every 30 hours
-   **Purpose**: Comprehensive refresh of all token type classifications and metadata across the entire system.
-   **Failure Impact**: Token categorization becomes outdated, affecting filtering, search, and risk assessments.

## Critical Failure Scenarios

### If Multiple Jobs Fail

-   **Core pool jobs failing**: The entire pool ecosystem becomes stale, making the API unreliable for DeFi applications
-   **Price jobs failing**: All economic calculations break down, rendering portfolio and swap calculations meaningless
-   **V3 jobs failing**: The latest Balancer protocol version becomes unsupported, cutting off access to new features
-   **User jobs failing**: Portfolio tracking and user experience severely degrade

### Monitoring and Alerts

Each job has CloudWatch alarms configured with different sensitivity levels:

-   **High-frequency jobs (< 1 minute)**: Alarm after 1 missed execution
-   **Regular jobs**: Alarm after 3 missed executions
-   **Low-frequency jobs**: Alarm after 1 missed execution to account for longer intervals

The alarm thresholds are adjusted for canary vs. production environments to balance alerting sensitivity with noise reduction.
