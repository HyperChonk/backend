-- Add missing partitions for BERACHAIN chains
-- These were added to the Chain enum in migration 20250710135432_add_berachain_chain
-- but the corresponding partitions were not created, causing insertion failures
CREATE TABLE events_berachain PARTITION OF "PartitionedPoolEvent" FOR VALUES IN ('BERACHAIN');
