// =============================================================================
// MODULE-BASED TYPES (Phase 13 custom RBAC)
// =============================================================================

/**
 * A module key. Was a literal union of the 6 seeded modules; now open, because
 * `rbac_modules` is authored from the UI and a runtime key cannot be a compile-
 * time union member. The registry is the authority on which keys exist —
 * `syncRoleRules` resolves keys against it and reports unknown ones as skipped.
 */
export type Module = string;

/** A verb key. Open for the same reason as Module. */
export type Action = string;

/** The 4 predefined roles with strict hierarchy */
export type PredefinedRole = 'Owner' | 'Admin' | 'Member' | 'Viewer';

/** Numeric hierarchy level: Owner=4, Admin=3, Member=2, Viewer=1 */
export type RoleLevel = 1 | 2 | 3 | 4;

/**
 * The 6 modules and 4 verbs the LEGACY fallback matrix is written in terms of.
 * Retained as unions so `ROLE_PERMISSIONS` below stays exhaustively checked:
 * it is the decision source whenever DYNAMIC_ABAC_ENABLED is not 'true', and it
 * must keep describing exactly the world it was written for. Deleted with the
 * matrix in Workstream J.
 */
export type LegacyModule = 'Accounts' | 'Schedules' | 'AIOps' | 'Inventory' | 'Settings' | 'Dashboard' | 'IAM';
export type LegacyAction = 'create' | 'read' | 'update' | 'delete';

/** Permission set shape — used by both static predefined roles and DB-stored custom roles */
export type PermissionSet = Record<string, string[]>;

/**
 * Maps old CASL subject names to new module names.
 * Used by authorize() for backward-compatible call sites during migration.
 */
export const SUBJECT_TO_MODULE: Record<string, Module> = {
    Account: 'Accounts',
    Schedule: 'Schedules',
    Resource: 'Inventory',
    Discovery: 'Inventory',
    // User/Role moved off Settings and onto their own IAM module — Members,
    // Roles, Permissions and Modules management no longer shares a gate with
    // general tenant settings (name, logo, billing, certificates).
    User: 'IAM',
    Role: 'IAM',
    Tenant: 'Settings',
    AuditLog: 'Accounts',   // audit read maps to Accounts read (D-03)
    Agent: 'AIOps',
    // Background agent RUNS (the Agent Ops screen), as distinct from the
    // interactive agent itself. Starting a run gates on this rather than on
    // `Agent`: the New Agent Run button lives on /app/agent-ops, and gating it
    // on `Agent` meant the page was reachable through one subject while its
    // primary action was governed by another — an admin who granted Agent Ops
    // in full still got a disabled button, with nothing on screen explaining
    // why. Required here as well as in the registry, because the LEGACY
    // decision path (authorize.ts's legacyDecision, still what production runs
    // while DYNAMIC_ABAC_ENABLED is false) resolves subjects through this map
    // and would otherwise fall through to treating 'AgentOps' as a module name,
    // find nothing, and deny.
    AgentOps: 'AIOps',
    // Recurring agent executions on a cron (the Scheduled Tasks screen), as
    // distinct from both the interactive agent and a one-off background run.
    // Same fix as AgentOps above, one level down: the registry has carried a
    // 'ScheduledTask' subject since 20260812100000 so /app/agent-ops/
    // scheduled-tasks would have a navPath owner, and the role editor renders it
    // as a grantable row — but every button and route on that page gated on
    // `Agent`, so an admin who granted Scheduled Task all four verbs still got
    // disabled pause/trigger/delete controls and no explanation. The row now
    // governs the operations it names. Required here as well as in the registry
    // for the LEGACY path (authorize.ts's legacyDecision, what production runs
    // while DYNAMIC_ABAC_ENABLED is false), which resolves subjects through this
    // map and would otherwise treat 'ScheduledTask' as a module name, find
    // nothing, and deny — passing locally under CASL and 403ing in prod.
    ScheduledTask: 'AIOps',
    // MCP server configuration (the MCP Servers screen). The registry has
    // carried a 'McpServer' subject since 20260812100000 — row, module link and
    // navPath /app/agent-ops/mcp-settings all present — so the role editor has
    // been rendering it as a grantable row that governed NOTHING: both backing
    // routes gated on a module-wide catch-all instead ('Settings' for
    // /api/agent-ops/mcp-settings, 'AIOps' for /api/mcp-servers). Ticking the
    // row changed nothing; the real control was the whole Settings or AI Ops
    // module. Exactly the gap ScheduledTask above had.
    //
    // 'Settings' was also the wrong module outright: nav-config.ts:41 files MCP
    // Servers under AIOps, so nav and permission disagreed — the same split the
    // Channel entry below was moved to fix.
    //
    // Required here as well as in the registry for the LEGACY path
    // (authorize.ts's legacyDecision, what production runs while
    // DYNAMIC_ABAC_ENABLED is false), which resolves subjects through this map
    // and would otherwise treat 'McpServer' as a module name, find nothing, and
    // deny — passing locally under CASL and 403ing in prod.
    McpServer: 'AIOps',
    // LLM provider configuration (the Providers screen). Same gap as McpServer
    // above and ScheduledTask before it: the registry has carried a 'Provider'
    // subject since 20260812100000 — row, module link, and navPath
    // /app/agent-ops/providers — so the role editor rendered "LLM Provider" as a
    // grantable row while every one of the seven /api/settings/providers/*
    // routes gated on the module-wide 'AIOps' catch-all. Ticking the row did
    // nothing; only the whole AI Ops module actually controlled it.
    //
    // Required here as well as in the registry for the LEGACY path
    // (authorize.ts's legacyDecision, what production runs while
    // DYNAMIC_ABAC_ENABLED is false), which resolves subjects through this map
    // and would otherwise treat 'Provider' as a module name, find nothing, and
    // deny — passing locally under CASL and 403ing in prod.
    Provider: 'AIOps',
    Skill: 'AIOps',
    Memory: 'AIOps',        // Agent memory module — gated with AI Ops (read=view, delete=prune)
    KnowledgeBase: 'AIOps', // Agent + KnowledgeBase collapsed into AI Ops (D-02)
    // Integration channels (Slack, Telegram, Discord, Jira, Webhook) — the
    // connectors that carry Agent Ops runs in and results back out. Under AIOps,
    // NOT Settings, matching what nav-config.ts has always claimed for
    // /app/channels and its per-channel pages. They were gated on 'Settings'
    // before, which meant the nav and the API disagreed about who owns the
    // feature: an AIOps-complete role saw Channels in the sidebar and got a 403
    // on every save. Same class of split the Providers page had (see the comment
    // at nav-config.ts:43) and the same fix — put the permission where the
    // feature already lives.
    Channel: 'AIOps',
    Billing: 'Settings',
    Certificate: 'Settings',
    RightSizing: 'Inventory', // right-sizing analyzes discovered inventory (read=view, update=review/trigger scan)
    // Read-only view of discovered inventory relationships. No update/delete action
    // exists for this subject, so it cannot become a privilege escalation.
    ResourceGraph: 'Inventory',
    // ScalingAudit maps to Inventory, same reasoning as RightSizing: it only reads
    // AWS scaling-activity history and writes advisory/audit rows (ScalingEvent,
    // coverage, policy snapshots) — it never calls a mutating AWS API. update=
    // trigger an on-demand poll, exactly like RightSizing's update=review/scan.
    //
    // Inventory's action set includes 'delete' (inherited from the module, not
    // granted specifically to this subject) — that grant is inert here by
    // construction: IScalingAuditRepository exposes no delete method, and the
    // database itself rejects DELETE on scaling_events via a trigger (see
    // libs/prisma/migrations/20260805120000_add_scaling_audit). The mismatch
    // between "Inventory:delete exists" and "nothing here is deletable" is a
    // reasoned choice, not an oversight — see the SpotGuard comment below for why
    // this repo prefers an honest existing-permission mapping over a bespoke
    // module for every subject.
    ScalingAudit: 'Inventory',
    // SpotGuard maps to Schedules, NOT Inventory — a deliberate choice, not an oversight.
    //
    // Spot Guard calls ecs:UpdateService with forceNewDeployment, i.e. it RESTARTS LIVE
    // PRODUCTION TASKS, exactly as the Cost Scheduler does when it scales a service.
    // Right Sizing, by contrast, only reads CloudWatch and writes advice rows, which is why
    // Inventory is right for it and wrong here.
    //
    // Mapping SpotGuard under Inventory would be a silent privilege escalation: every
    // existing holder of Inventory:update (today meaning "approve a recommendation, trigger
    // a read-only scan") would instantly gain the power to bounce production ECS services,
    // without anyone editing a role. Schedules:update already carries "may change running
    // AWS compute" semantics, so the grant is honest and no existing permission set changes
    // meaning.
    SpotGuard: 'Schedules',
    Dashboard: 'Dashboard',   // unified dashboard read permission
    IAM: 'IAM',              // module-wide subject, same pattern as AIOps/Settings
    all: 'Settings',        // wildcard fallback
};

/**
 * Maps old CASL action names to new CRUD actions.
 * Used by authorize() for backward-compatible call sites during migration.
 */
export const ACTION_MAP: Record<string, Action | Action[]> = {
    execute: 'update',   // schedule execution maps to update (D-03)
    approve: 'update',
    export: 'read',      // audit export maps to read (D-03)
    validate: 'read',
    use: 'read',
    manage: ['create', 'read', 'update', 'delete'],
    create: 'create',
    read: 'read',
    update: 'update',
    delete: 'delete',
};

// =============================================================================
// PERSISTENCE TYPES — used by repository layer and role-service
// =============================================================================

/** Role values stored in DynamoDB/PostgreSQL for tenant membership */
export type TenantRole = 'SuperAdmin' | 'TenantAdmin' | 'TenantOperator' | 'TenantViewer';

/** Shape of a user-tenant-role record returned from the repository */
export interface UserTenantRole {
    PK: string;
    SK: string;
    EntityType: 'UserTenantRole';
    userId: string;
    tenantId: string;
    email: string;
    role: TenantRole;
    assignedAt: string;
    assignedBy: string;
}
