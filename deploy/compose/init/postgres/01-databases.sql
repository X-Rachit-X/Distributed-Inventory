-- ============================================================================
-- One database per service.
--
-- Separate databases, not separate schemas, because the architectural claim is
-- that each service owns its data. Sharing a schema makes it trivially easy for
-- a future change to join across a boundary and quietly couple two services
-- forever. Separate databases make that cost visible: you have to write a saga.
--
-- They run in one PostgreSQL instance here purely because this is a laptop.
-- Nothing in the application assumes co-location — no cross-database query
-- exists anywhere in the codebase, which is what would break in production.
--
-- The one deliberate exception is the reconciliation service, which is granted
-- READ-ONLY roles on the other databases. Reconciliation's entire job is to
-- compare services against one another and report where they disagree; doing
-- that over HTTP would be slower, racier, and would let a sick service hide its
-- own inconsistency. The access is read-only and documented as a known
-- exception rather than an accident.
-- ============================================================================

CREATE DATABASE inventory;
CREATE DATABASE reservation;
CREATE DATABASE payment;
CREATE DATABASE reconciliation;
CREATE DATABASE notification;
CREATE DATABASE discovery;

-- Read-only role used only by the reconciliation worker.
CREATE ROLE tessera_readonly LOGIN PASSWORD 'tessera_readonly';

\connect inventory
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
GRANT CONNECT ON DATABASE inventory TO tessera_readonly;
GRANT USAGE ON SCHEMA public TO tessera_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO tessera_readonly;

\connect reservation
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
GRANT CONNECT ON DATABASE reservation TO tessera_readonly;
GRANT USAGE ON SCHEMA public TO tessera_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO tessera_readonly;

\connect payment
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
GRANT CONNECT ON DATABASE payment TO tessera_readonly;
GRANT USAGE ON SCHEMA public TO tessera_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO tessera_readonly;

\connect reconciliation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

\connect notification
CREATE EXTENSION IF NOT EXISTS pgcrypto;

\connect discovery
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
