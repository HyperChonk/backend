-- Add missing partitions for HYPEREVM chains
-- These were added to the Chain enum in migration 20250603065543_add_hyperevm_chains
-- but the corresponding partitions were not created, causing insertion failures

CREATE TABLE events_hyperevm PARTITION OF "PartitionedPoolEvent" FOR VALUES IN ('HYPEREVM');
CREATE TABLE events_hyperevm_testnet PARTITION OF "PartitionedPoolEvent" FOR VALUES IN ('HYPEREVM_TESTNET');
