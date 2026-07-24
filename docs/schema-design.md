# DynamoDB Schema Design - Nucleus Platform

> **⚠️ Historical document.** This describes the original DynamoDB single-table design,
> which has been **fully replaced by PostgreSQL + Prisma**. It is kept for context on the
> migration only. The current data model is `libs/prisma/schema.prisma`.

## 1. Overview
The platform utilizes two distinct DynamoDB tables:
1.  **NucleusAppTable**: Stores configuration logic (Accounts, Schedules, Mappings) using Single Table Design.
2.  **NucleusAuditTable**: Stores high-volume immutable logs with TTL.

---

## 2. NucleusAppTable (Single Table Design)

### 2.1. Key Definitions
*   **Partition Key (PK)**: `pk` (String)
*   **Sort Key (SK)**: `sk` (String)
*   **GSI1 PK**: `gsi1pk` (String) - Used for listing entities by type or reverse searches.
*   **GSI1 SK**: `gsi1sk` (String)

### 2.2. Entity Patterns

#### A. Account
Represents an integrated AWS Account.

| Attribute | Value Pattern | Notes |
| :--- | :--- | :--- |
| **PK** | `ACCOUNT#<AccountId>` | Unique ID of the account |
| **SK** | `METADATA` | |
| **GSI1PK** | `TYPE#ACCOUNT` | Enables "List All Accounts" |
| **GSI1SK** | `<AccountName>` | Sort alphabetically by name |
| **Attributes** | `account_name`, `role_arn`, `status`, `last_test_run_at`, `created_at` | |

#### B. Schedule
Represents a user-defined schedule (e.g., "Dev Environment Shutdown").

| Attribute | Value Pattern | Notes |
| :--- | :--- | :--- |
| **PK** | `SCHEDULE#<ScheduleId>` | Unique ID (UUID) |
| **SK** | `METADATA` | |
| **GSI1PK** | `TYPE#SCHEDULE` | Enables "List All Schedules" |
| **GSI1SK** | `<ScheduleName>` | Sort alphabetically |
| **Attributes** | `schedule_name`, `start_cron`, `end_cron`, `timezone`, `enabled` | |

#### C. Targeted Resource
Represents a specific AWS resource (EC2, ECS, RDS) attached to a schedule.

| Attribute | Value Pattern | Notes |
| :--- | :--- | :--- |
| **PK** | `SCHEDULE#<ScheduleId>` | Same partition as Schedule for efficient retrieval |
| **SK** | `RESOURCE#<ResourceArn>` | Uniquely identifies resource |
| **GSI1PK** | `ACCOUNT#<AccountId>` | Find all scheduled resources for an account |
| **GSI1SK** | `SCHEDULE#<ScheduleId>` | |
| **Attributes** | `resource_type`, `region`, `account_id` | |

### 2.3. Data Modeling & Access Patterns

1.  **Get Schedule and all its Resources**:
    *   Query `PK = SCHEDULE#<id>`
    *   Result: `METADATA` item + N `RESOURCE` items.
2.  **List All Active Accounts**:
    *   Query GSI1: `PK = TYPE#ACCOUNT`
3.  **List All Schedules**:
    *   Query GSI1: `PK = TYPE#SCHEDULE`

---

## 3. NucleusAuditTable (Audit Logs)

This table allows querying logs by entity (Account/Schedule) or timeline.

### 3.1. Key Definitions
*   **Partition Key (PK)**: `pk` (String) -> `ENTITY#<EntityId>` (e.g., `SCHEDULE#123` or `ACCOUNT#456` or `GLOBAL`)
*   **Sort Key (SK)**: `sk` (String) -> `TIMESTAMP#<ISO8601>`
*   **TTL Attribute**: `expire_at` (Epoch Timestamp)

### 3.2. Log Pattern

| Attribute | Value Pattern | Notes |
| :--- | :--- | :--- |
| **PK** | `ENTITY#<EntityId>` | Group logs by the object being modified |
| **SK** | `TIMESTAMP#<ISO8601>` | Chronological ordering |
| **Attributes** | `action` (CREATE/UPDATE/EXECUTE), `user_id`, `details` (JSON), `status` (SUCCESS/FAIL) | |

*   **Global/Recent Logs**: To show a "Recent Activity" dashboard, we can use a separate GSI or a "Time Bucket" PK (e.g., `PK=DATE#2023-10-27`).
    *   **Recommendation**: Use `GSI1PK = AUDIT#GLOBAL`, `GSI1SK = TIMESTAMP#<ISO8601>` to allow global chronological view.

### 3.3. Retention
*   Enable DynamoDB TTL on `expire_at` attribute.
*   Set to `CurrentTime + 30 Days`.
