#!/usr/bin/env npx tsx
/**
 * migrate-all.ts
 *
 * Orchestrates all DynamoDB → PostgreSQL migration scripts in dependency order.
 * Stops on first error and prints a resume command.
 *
 * Usage:
 *   AWS_PROFILE=PLATFORM-ADMIN DATABASE_URL=postgresql://... npx tsx scripts/migrate-all.ts
 *   npx tsx scripts/migrate-all.ts --from migrate-accounts       # resume from a specific script
 *   npx tsx scripts/migrate-all.ts --dry-run                     # pass --dry-run to all child scripts
 *
 * Migration order (dependency-safe):
 *   1. migrate-tenant-configs  — tenants + tenant_configs (parent entity, no deps)
 *   2. migrate-accounts        — accounts (depends on tenants existing)
 *   3. migrate-rbac            — user_tenant_roles
 *   4. migrate-schedules       — schedules + schedule_executions
 *   5. migrate-audit-logs      — audit_logs
 *   6. migrate-kb              — knowledge_bases + data_sources
 *   7. migrate-inventory       — inventory_resources + inventory_vector_keys
 *   8. migrate-agent-ops       — agent_ops_runs + agent_ops_events + scheduled_tasks + scheduled_task_locks
 *
 * Skipped tables (fresh start — see D-08/D-09 in 05-CONTEXT.md):
 *   - DYNAMODB_CHAT_HISTORY_TABLE  — ephemeral chat history (30-day TTL)
 *   - DYNAMODB_MEMORY_TABLE        — ephemeral agent memory (90-day TTL)
 */

import { spawnSync } from 'child_process';
import * as path from 'path';

// ── Migration Order ────────────────────────────────────────────────────────────

const MIGRATION_ORDER = [
    {
        name: 'migrate-tenant-configs',
        script: 'scripts/migrate-tenant-configs.ts',
        description: 'Tenants + Tenant Configs',
    },
    {
        name: 'migrate-accounts',
        script: 'scripts/migrate-accounts.ts',
        description: 'Accounts',
    },
    {
        name: 'migrate-rbac',
        script: 'scripts/migrate-rbac.ts',
        description: 'RBAC (User Tenant Roles)',
    },
    {
        name: 'migrate-schedules',
        script: 'scripts/migrate-schedules.ts',
        description: 'Schedules + Executions',
    },
    {
        name: 'migrate-audit-logs',
        script: 'scripts/migrate-audit-logs.ts',
        description: 'Audit Logs',
    },
    {
        name: 'migrate-kb',
        script: 'scripts/migrate-kb.ts',
        description: 'Knowledge Bases + Data Sources',
    },
    {
        name: 'migrate-inventory',
        script: 'scripts/migrate-inventory.ts',
        description: 'Inventory Resources + Vector Keys',
    },
    {
        name: 'migrate-agent-ops',
        script: 'scripts/migrate-agent-ops.ts',
        description: 'Agent Ops (Runs, Events, Tasks, Locks)',
    },
];

// ── Configuration ─────────────────────────────────────────────────────────────

const APP_TABLE_NAME = process.env.APP_TABLE_NAME ?? process.env.DYNAMODB_TABLE_NAME;
const DATABASE_URL = process.env.DATABASE_URL;

if (!APP_TABLE_NAME) {
    console.error('ERROR: APP_TABLE_NAME (or DYNAMODB_TABLE_NAME) environment variable is required');
    process.exit(1);
}

if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
}

// ── CLI Argument Parsing ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fromIndex = args.indexOf('--from');
const dryRun = args.includes('--dry-run');

let fromName: string | null = null;
if (fromIndex !== -1) {
    fromName = args[fromIndex + 1] ?? null;
    if (!fromName) {
        console.error('ERROR: --from requires a script name (e.g. --from migrate-accounts)');
        process.exit(1);
    }
    const found = MIGRATION_ORDER.find((m) => m.name === fromName);
    if (!found) {
        console.error(`ERROR: Unknown script name "${fromName}" for --from flag.`);
        console.error('Valid names:', MIGRATION_ORDER.map((m) => m.name).join(', '));
        process.exit(1);
    }
}

// ── Build Script List ──────────────────────────────────────────────────────────

let scriptsToRun = MIGRATION_ORDER;
if (fromName) {
    const startIdx = MIGRATION_ORDER.findIndex((m) => m.name === fromName);
    scriptsToRun = MIGRATION_ORDER.slice(startIdx);
    console.log(`Resuming from: ${fromName} (skipping ${startIdx} earlier script(s))\n`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log('Nucleus Cloud Ops — Full DynamoDB → PostgreSQL Migration');
console.log('='.repeat(60));
console.log(`Scripts to run: ${scriptsToRun.length} of ${MIGRATION_ORDER.length}`);
if (dryRun) {
    console.log('Mode: DRY RUN (--dry-run passed to all child scripts)');
}
console.log(`AWS_PROFILE: ${process.env.AWS_PROFILE ?? '(default)'}`);
console.log('');

const cwd = process.cwd();
let completed = 0;

for (let i = 0; i < scriptsToRun.length; i++) {
    const entry = scriptsToRun[i];
    const scriptPath = path.join(cwd, entry.script);
    const childArgs = ['tsx', scriptPath, ...(dryRun ? ['--dry-run'] : [])];

    console.log(`\n[${ i + 1 }/${ scriptsToRun.length }] Running ${entry.name} — ${entry.description}`);
    console.log('-'.repeat(60));

    const result = spawnSync('npx', childArgs, {
        stdio: 'inherit',
        env: process.env,
        cwd,
    });

    if (result.error) {
        console.error(`\nFAILED: ${entry.name} — spawn error: ${result.error.message}`);
        console.error(`Resume after fixing: npx tsx scripts/migrate-all.ts --from ${entry.name}`);
        process.exit(1);
    }

    if (result.status !== 0) {
        console.error(`\nFAILED: ${entry.name} exited with code ${result.status}`);
        console.error(`Resume after fixing: npx tsx scripts/migrate-all.ts --from ${entry.name}`);
        process.exit(1);
    }

    completed += 1;
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`All ${completed} migration script(s) completed successfully.`);
console.log('='.repeat(60));
console.log('');
console.log('Skipped tables (fresh start — ephemeral data):');
console.log('  DYNAMODB_CHAT_HISTORY_TABLE  — chat history (30-day TTL): SKIPPED');
console.log('  DYNAMODB_MEMORY_TABLE        — agent memory (90-day TTL): SKIPPED');
console.log('');
console.log('Chat history + memory tables: SKIPPED (fresh start — ephemeral data with 30/90-day TTL)');
console.log('See D-08/D-09 in .planning/phases/05-langgraph-migration-validation/05-CONTEXT.md');
console.log('');
console.log('Next step: run verify-migration.ts to confirm row counts match.');
console.log('  npx tsx scripts/verify-migration.ts');
