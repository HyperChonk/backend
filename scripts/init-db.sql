-- Initialize database for local development
-- This runs automatically when the Postgres container starts

-- Ensure the database exists
\c database;

-- Create basic extensions that might be needed
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Set timezone
SET timezone = 'UTC';

-- You can add any additional setup here