/**
 * Gate 4 — agent tool capability enforcement.
 *
 * The headline property: a VIEWER's agent session is built WITHOUT
 * execute_command. Not "with a refusing execute_command" — without it, so the
 * model never proposes a shell call it cannot make.
 *
 * The registry fixture is a faithful slice of the seed in
 * libs/prisma/migrations/20260730000000_dynamic_abac/migration.sql: the AIOps
 * module, the five capability subjects hanging off it, and the alias chains
 * `execute -> update` and `use -> read`. Building the ability through the REAL
 * compiler is the point — a hand-written rule list would not exercise the alias
 * resolution that the whole gate turns on.
 */

import { createMongoAbility } from '@casl/ability';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildActionAliasMap, compileRules } from '@nucleus/rbac';
import type { AbilityPrincipal, RbacRoleRuleRow, RegistrySnapshot } from '@nucleus/rbac';

vi.mock('@/lib/rbac/denials', () => ({ recordDenial: vi.fn().mockResolvedValue(undefined) }));

import { recordDenial } from '@/lib/rbac/denials';
import { createToolGate, MAX_DENIALS_PER_RUN, type GateableTool, type ToolGateOptions } from './tool-gate';
import { TOOL_CAPABILITIES } from './tool-capabilities';

// ── Registry fixture ─────────────────────────────────────────────────────────

const action = (key: string, aliasOfKey: string | null = null) => ({
    id: `a-${key}`,
    tenantId: null,
    key,
    label: key,
    description: null,
    aliasOfKey,
    isDangerous: false,
    sortOrder: 10,
    isSystem: true,
});

const capability = (key: string) => ({
    id: `s-${key.toLowerCase()}`,
    tenantId: null,
    key,
    label: key,
    kind: 'capability' as const,
    isSystem: true,
});

const CAPABILITY_KEYS = ['AgentShell', 'AgentFile', 'AgentStorage', 'AgentWeb', 'AgentMcp'];
const TERMINAL_ACTIONS = ['create', 'read', 'update', 'delete'];

function registry(): RegistrySnapshot {
    return {
        tenantId: 't1',
        modules: [
            {
                id: 'm-aiops',
                tenantId: null,
                key: 'AIOps',
                label: 'AI Ops',
                description: null,
                icon: null,
                navPath: null,
                sortOrder: 30,
                isSystem: true,
                enabled: true,
            },
        ],
        actions: [
            ...TERMINAL_ACTIONS.map((k) => action(k)),
            // The two aliases the tool map depends on.
            action('execute', 'update'),
            action('use', 'read'),
        ],
        subjects: [
            { id: 's-agent', tenantId: null, key: 'Agent', label: 'Agent', kind: 'resource', isSystem: true },
            ...CAPABILITY_KEYS.map(capability),
        ],
        subjectModules: [
            { tenantId: null, subjectId: 's-agent', moduleId: 'm-aiops' },
            ...CAPABILITY_KEYS.map((k) => ({
                tenantId: null,
                subjectId: `s-${k.toLowerCase()}`,
                moduleId: 'm-aiops',
            })),
        ],
        moduleActions: TERMINAL_ACTIONS.map((k) => ({
            tenantId: null,
            moduleId: 'm-aiops',
            actionId: `a-${k}`,
            grantable: true,
        })),
        subjectAttributes: [],
        principalAttributes: [],
    };
}

/** Module-level AIOps grants, exactly the shape the preset-role seed produces. */
function aiopsRules(roleId: string, actions: string[]): RbacRoleRuleRow[] {
    return actions.map((key) => ({
        id: `rule-${roleId}-${key}`,
        tenantId: null,
        roleId,
        actionId: `a-${key}`,
        moduleId: 'm-aiops',
        subjectId: null,
        conditions: null,
        fields: [],
        inverted: false,
        reason: null,
    }));
}

function principal(roleName: string, over: Partial<AbilityPrincipal> = {}): AbilityPrincipal {
    return {
        userId: 'u1',
        email: 'u1@example.com',
        tenantId: 't1',
        roleId: `preset-${roleName.toLowerCase()}`,
        roleName,
        level: 1,
        isSuperAdmin: false,
        attributes: {},
        ...over,
    };
}

function gateFor(roleName: string, actions: string[], rules?: RbacRoleRuleRow[]) {
    const snapshot = registry();
    const who = principal(roleName);
    const compiled = compileRules(snapshot, rules ?? aiopsRules(who.roleId!, actions), who);
    expect(compiled.dropped).toEqual([]);
    return createToolGate({
        ability: createMongoAbility(compiled.rules),
        principal: who,
        actionAliases: buildActionAliasMap(snapshot.actions),
        mcpToolNames: MCP_NAMES,
    });
}

// ── Fake tools ───────────────────────────────────────────────────────────────

const invoked: string[] = [];

function fakeTool(name: string): GateableTool {
    return {
        name,
        description: `fake ${name}`,
        schema: {},
        async invoke(input: unknown) {
            invoked.push(name);
            return `ran ${name}(${JSON.stringify(input)})`;
        },
    };
}

/** Every gated built-in, plus one ungated tool and one MCP tool. */
const ALL_TOOL_NAMES = [...Object.keys(TOOL_CAPABILITIES), 'ask_user', 'mcp__aws__list_buckets'];
const MCP_NAMES = new Set(['mcp__aws__list_buckets']);

function allTools(): GateableTool[] {
    return ALL_TOOL_NAMES.map(fakeTool);
}

beforeEach(() => {
    invoked.length = 0;
    vi.mocked(recordDenial).mockClear();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('agent tool capability gate — Viewer', () => {
    const viewerGate = () => gateFor('Viewer', ['read']);

    it('builds a Viewer session WITHOUT execute_command', () => {
        const { tools, omitted } = viewerGate().filter(allTools());

        expect(tools.map((t) => t.name)).not.toContain('execute_command');
        expect(omitted).toContain('execute_command');
    });

    it('omits every write capability but keeps every read capability', () => {
        const { tools } = viewerGate().filter(allTools());
        const names = tools.map((t) => t.name);

        // Denied: execute AgentShell, update AgentFile, create AgentStorage.
        expect(names).not.toContain('execute_command');
        expect(names).not.toContain('write_file');
        expect(names).not.toContain('edit_file');
        expect(names).not.toContain('write_file_to_s3');

        // Granted through AIOps:read — including the two aliased checks
        // (`use AgentMcp` -> read, and read on the file/storage/web subjects).
        expect(names).toEqual(
            expect.arrayContaining([
                'read_file', 'ls', 'glob', 'grep',
                'get_file_from_s3', 'web_search',
                'mcp__aws__list_buckets',
            ]),
        );
    });

    it('keeps ungated tools regardless of role', () => {
        const { tools, decisions } = viewerGate().filter(allTools());

        expect(tools.map((t) => t.name)).toContain('ask_user');
        // ask_user is not a gated tool at all, so it produces no decision.
        expect(decisions.map((d) => d.tool)).not.toContain('ask_user');
    });
});

describe('agent tool capability gate — Member and Owner', () => {
    it('gives a Member execute_command via the execute -> update alias', () => {
        const { tools, omitted } = gateFor('Member', ['create', 'read', 'update']).filter(allTools());

        expect(tools.map((t) => t.name)).toContain('execute_command');
        expect(omitted).toEqual([]);
    });

    it('gives an Owner the complete tool set', () => {
        const { tools, omitted } = gateFor('Owner', ['create', 'read', 'update', 'delete']).filter(allTools());

        expect(omitted).toEqual([]);
        expect(tools).toHaveLength(ALL_TOOL_NAMES.length);
    });

    it('gives a role with no AIOps grant at all nothing but the ungated tools', () => {
        const { tools } = gateFor('Stranger', []).filter(allTools());
        expect(tools.map((t) => t.name)).toEqual(['ask_user']);
    });

    it('gives a SuperAdmin every tool without consulting a single rule', () => {
        const snapshot = registry();
        const who = principal('SuperAdmin', { isSuperAdmin: true, roleId: null });
        const compiled = compileRules(snapshot, [], who);
        const gate = createToolGate({
            ability: createMongoAbility(compiled.rules),
            principal: who,
            // SuperAdmin compiles to `manage all`, so there are no aliases to apply.
            actionAliases: {},
        });

        expect(gate.filter(allTools()).omitted).toEqual([]);
    });
});

describe('MCP tools', () => {
    it('gates MCP tools on `use AgentMcp` by origin, not by name', () => {
        // A tool with the same name that did NOT come from an MCP server is
        // ungated — the set passed to the gate is what decides.
        const notFromMcp = createToolGate({
            ...gateInputs('Viewer', ['read']),
            mcpToolNames: new Set<string>(),
        }).filter([fakeTool('mcp__aws__list_buckets')]);
        expect(notFromMcp.decisions).toEqual([]);

        const fromMcp = createToolGate({
            ...gateInputs('Viewer', ['read']),
            mcpToolNames: MCP_NAMES,
        }).filter([fakeTool('mcp__aws__list_buckets')]);
        expect(fromMcp.decisions[0]).toMatchObject({
            requirement: { action: 'use', subject: 'AgentMcp' },
            verdict: 'allow',
        });
    });

    it('omits MCP tools for a role with no AIOps read', () => {
        const { tools } = createToolGate({
            ...gateInputs('Stranger', []),
            mcpToolNames: MCP_NAMES,
        }).filter([fakeTool('mcp__aws__list_buckets')]);
        expect(tools).toEqual([]);
    });
});

/** Same construction as gateFor(), exposed for the MCP tests that need to vary mcpToolNames. */
function gateInputs(roleName: string, actions: string[]): Omit<ToolGateOptions, 'mcpToolNames'> {
    const snapshot = registry();
    const who = principal(roleName);
    const compiled = compileRules(snapshot, aiopsRules(who.roleId!, actions), who);
    return {
        ability: createMongoAbility(compiled.rules),
        principal: who,
        actionAliases: buildActionAliasMap(snapshot.actions),
    };
}

describe('conditional grants', () => {
    /** `execute AgentShell` granted only when the command targets a dry run. */
    function conditionalShellGate() {
        const snapshot = registry();
        // The condition references an attribute of the capability subject, so the
        // fixture must declare it or the compiler rejects the rule.
        snapshot.subjectAttributes = [
            {
                tenantId: null,
                subjectId: 's-agentshell',
                path: 'command',
                label: 'Command',
                valueType: 'string',
                operators: ['$eq', '$ne', '$in', '$nin'],
                enumValues: [],
            },
        ];
        const who = principal('Restricted');
        const rules: RbacRoleRuleRow[] = [
            {
                id: 'rule-cond',
                tenantId: null,
                roleId: who.roleId!,
                actionId: 'a-execute',
                moduleId: null,
                subjectId: 's-agentshell',
                conditions: { command: 'aws sts get-caller-identity' },
                fields: [],
                inverted: false,
                reason: 'Only the identity probe is permitted',
            },
        ];
        const compiled = compileRules(snapshot, rules, who);
        expect(compiled.dropped).toEqual([]);
        return createToolGate({
            ability: createMongoAbility(compiled.rules),
            principal: who,
            actionAliases: buildActionAliasMap(snapshot.actions),
        });
    }

    it('binds a conditionally-granted tool rather than omitting it', () => {
        const { tools, decisions, omitted } = conditionalShellGate().filter([fakeTool('execute_command')]);

        expect(omitted).toEqual([]);
        expect(tools.map((t) => t.name)).toEqual(['execute_command']);
        expect(decisions[0].verdict).toBe('conditional');
    });

    it('runs the tool when the arguments satisfy the condition', async () => {
        const { tools } = conditionalShellGate().filter([fakeTool('execute_command')]);

        const result = await tools[0].invoke({ command: 'aws sts get-caller-identity' });

        expect(invoked).toEqual(['execute_command']);
        expect(String(result)).toContain('ran execute_command');
    });

    it('returns a structured denial string — never throws — when they do not', async () => {
        const { tools } = conditionalShellGate().filter([fakeTool('execute_command')]);

        const result = await tools[0].invoke({ command: 'rm -rf /' });

        expect(invoked).toEqual([]); // the underlying tool never ran
        expect(String(result)).toContain('PERMISSION_DENIED');
        expect(String(result)).toContain('execute AgentShell');
        expect(String(result)).toContain('Only the identity probe is permitted');
        expect(String(result)).toContain('Do not retry');
    });

    it('audits each denial', async () => {
        const { tools } = conditionalShellGate().filter([fakeTool('execute_command')]);

        await tools[0].invoke({ command: 'rm -rf /' });

        expect(recordDenial).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'u1',
                tenantId: 't1',
                roleName: 'Restricted',
                action: 'execute',
                subject: 'AgentShell',
            }),
        );
    });

    it(`caps denials at ${MAX_DENIALS_PER_RUN} per run and then tells the model to stop`, async () => {
        const { tools } = conditionalShellGate().filter([fakeTool('execute_command')]);
        const results: string[] = [];

        for (let i = 0; i < MAX_DENIALS_PER_RUN + 2; i++) {
            results.push(String(await tools[0].invoke({ command: `denied-${i}` })));
        }

        // First N explain; everything after is the hard stop.
        for (let i = 0; i < MAX_DENIALS_PER_RUN; i++) {
            expect(results[i]).toContain('PERMISSION_DENIED:');
        }
        for (let i = MAX_DENIALS_PER_RUN; i < results.length; i++) {
            expect(results[i]).toContain('PERMISSION_DENIED_LIMIT');
        }

        // Past the cap nothing further is audited — a looping model must not be
        // able to write unbounded audit rows.
        expect(recordDenial).toHaveBeenCalledTimes(MAX_DENIALS_PER_RUN);
    });

    it('keeps the cap per-run: a freshly built gate starts at zero', async () => {
        const first = conditionalShellGate().filter([fakeTool('execute_command')]);
        for (let i = 0; i < MAX_DENIALS_PER_RUN + 1; i++) await first.tools[0].invoke({ command: 'no' });

        const second = conditionalShellGate().filter([fakeTool('execute_command')]);
        const result = String(await second.tools[0].invoke({ command: 'no' }));

        expect(result).toContain('PERMISSION_DENIED:');
        expect(result).not.toContain('PERMISSION_DENIED_LIMIT');
    });
});

describe('tool -> capability map', () => {
    it('maps every dangerous built-in to the capability the plan specifies', () => {
        expect(TOOL_CAPABILITIES).toMatchObject({
            execute_command: { action: 'execute', subject: 'AgentShell' },
            write_file: { action: 'update', subject: 'AgentFile' },
            edit_file: { action: 'update', subject: 'AgentFile' },
            read_file: { action: 'read', subject: 'AgentFile' },
            ls: { action: 'read', subject: 'AgentFile' },
            glob: { action: 'read', subject: 'AgentFile' },
            grep: { action: 'read', subject: 'AgentFile' },
            write_file_to_s3: { action: 'create', subject: 'AgentStorage' },
            get_file_from_s3: { action: 'read', subject: 'AgentStorage' },
            web_search: { action: 'read', subject: 'AgentWeb' },
        });
    });

    it('leaves ask_user ungated', () => {
        expect(TOOL_CAPABILITIES).not.toHaveProperty('ask_user');
    });
});
