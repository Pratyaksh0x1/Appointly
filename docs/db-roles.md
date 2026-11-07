# Appointly Least-Privilege Database Role Architecture

## Overview

In alignment with **Non-negotiable Rule 1** (LLM never writes to database directly) and security best practices, Appointly enforces a strict separation of database roles between **Schema Migration (DDL)**, **Application Runtime (DML)**, and **Read-Only Audit/Analytics**.

---

## Role Matrix

| Role                       | Intended Usage                                          | DDL (CREATE/ALTER/DROP/TRUNCATE) | DML (SELECT/INSERT/UPDATE) |    DELETE on Clinical Records    |
| :------------------------- | :------------------------------------------------------ | :------------------------------: | :------------------------: | :------------------------------: |
| `appointly_migration_role` | CI/CD pipelines & schema migrations (`npm run migrate`) |              ✅ Yes              |           ✅ Yes           |              ✅ Yes              |
| `appointly_app_role`       | Stateless API backend runtime                           |          ❌ **Revoked**          |           ✅ Yes           | ✅ Yes (Scoped to holds/cancels) |
| `appointly_readonly_role`  | Analytics, audits & dashboard read replicas             |          ❌ **Revoked**          |       🔍 SELECT Only       |          ❌ **Revoked**          |

---

## Security Guarantees

1. **Zero Schema Alteration via API**:
   - `appointly_app_role` is explicitly stripped of `CREATE`, `DROP`, `TRUNCATE`, and `ALTER` privileges.
   - Even in the event of an arbitrary SQL injection or compromised tool call, an attacker or runaway LLM cannot drop tables, truncate clinical records, or alter indexes.
2. **Neon Connection String Segregation**:
   - `DATABASE_URL` used by the production API connects as `appointly_app_role` over Neon's connection pooler (`-pooler` endpoint).
   - Migration scripts utilize `DATABASE_URL_UNPOOLED` authenticated as `appointly_migration_role`.
3. **Execution Script**:
   - The setup script is provisioned in [`scripts/setup-least-privilege-db-roles.sql`](../scripts/setup-least-privilege-db-roles.sql).
