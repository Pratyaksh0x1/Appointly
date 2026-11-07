-- Appointly Least-Privilege Database Role Provisioning
-- Separates DDL migration administrative privileges from runtime application DML access.

-- ============================================================================
-- 1. Migration Role (DDL / Schema Migrations Only)
-- ============================================================================
-- Used strictly by CI/CD and 'npm run migrate' during deployment.
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'appointly_migration_role') THEN
    CREATE ROLE appointly_migration_role WITH LOGIN PASSWORD 'change_me_in_vault';
  END IF;
END $$;

GRANT ALL PRIVILEGES ON SCHEMA public TO appointly_migration_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO appointly_migration_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO appointly_migration_role;

-- ============================================================================
-- 2. Application Runtime Role (Least-Privilege DML Only)
-- ============================================================================
-- Used by the stateless API backend at runtime.
-- Strictly NO DROP, NO ALTER, NO TRUNCATE privileges to prevent destructive SQL injections.
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'appointly_app_role') THEN
    CREATE ROLE appointly_app_role WITH LOGIN PASSWORD 'change_me_in_vault';
  END IF;
END $$;

-- Allow schema connection & usage
GRANT CONNECT ON DATABASE neondb TO appointly_app_role;
GRANT USAGE ON SCHEMA public TO appointly_app_role;

-- Grant strictly DML operations
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE 
  doctors,
  appointment_types,
  patients,
  appointments,
  slot_holds,
  calls,
  outbox,
  callback_requests,
  credit_audit_logs
TO appointly_app_role;

-- Sequence usage for serial primary keys
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO appointly_app_role;

-- Explicitly revoke DDL powers
REVOKE CREATE ON SCHEMA public FROM appointly_app_role;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM appointly_app_role;

-- Default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO appointly_app_role;

-- ============================================================================
-- 3. Read-Only Auditor / Analytics Role (Zero Mutation)
-- ============================================================================
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'appointly_readonly_role') THEN
    CREATE ROLE appointly_readonly_role WITH LOGIN PASSWORD 'change_me_in_vault';
  END IF;
END $$;

GRANT CONNECT ON DATABASE neondb TO appointly_readonly_role;
GRANT USAGE ON SCHEMA public TO appointly_readonly_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO appointly_readonly_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO appointly_readonly_role;

