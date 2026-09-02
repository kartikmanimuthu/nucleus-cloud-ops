import { describe, it, expect } from 'vitest';
import { queryKeys } from './query-keys';

describe('queryKeys', () => {
    describe('accounts', () => {
        it('builds the list/detail/stats/scan hierarchy', () => {
            expect(queryKeys.accounts.all).toEqual(['accounts']);
            expect(queryKeys.accounts.lists()).toEqual(['accounts', 'list']);
            expect(queryKeys.accounts.list({ region: 'us-east-1' })).toEqual([
                'accounts', 'list', { region: 'us-east-1' },
            ]);
            expect(queryKeys.accounts.list()).toEqual(['accounts', 'list', {}]);
            expect(queryKeys.accounts.details()).toEqual(['accounts', 'detail']);
            expect(queryKeys.accounts.detail('a1')).toEqual(['accounts', 'detail', 'a1']);
            expect(queryKeys.accounts.stats()).toEqual(['accounts', 'stats']);
            expect(queryKeys.accounts.scan('a1')).toEqual(['accounts', 'scan', 'a1']);
        });
    });

    describe('schedules', () => {
        it('nests executions under the detail key', () => {
            expect(queryKeys.schedules.detail('s1')).toEqual(['schedules', 'detail', 's1']);
            expect(queryKeys.schedules.executions('s1', { page: 1 })).toEqual([
                'schedules', 'detail', 's1', 'executions', { page: 1 },
            ]);
            expect(queryKeys.schedules.executions('s1')).toEqual([
                'schedules', 'detail', 's1', 'executions', {},
            ]);
        });
    });

    describe('audit', () => {
        it('builds list and stats keys with optional filters', () => {
            expect(queryKeys.audit.list()).toEqual(['audit', 'list', {}]);
            expect(queryKeys.audit.stats({ range: '7d' })).toEqual(['audit', 'stats', { range: '7d' }]);
        });
    });

    describe('rightSizing', () => {
        it('builds recommendations/summary/detail keys', () => {
            expect(queryKeys.rightSizing.recommendations({ status: 'open' })).toEqual([
                'right-sizing', 'recommendations', { status: 'open' },
            ]);
            expect(queryKeys.rightSizing.summary()).toEqual(['right-sizing', 'summary']);
            expect(queryKeys.rightSizing.detail('r1')).toEqual(['right-sizing', 'detail', 'r1']);
        });
    });

    describe('scalingAudit', () => {
        it('builds resources/events/detail/summary/runs/coverage keys', () => {
            expect(queryKeys.scalingAudit.resources()).toEqual(['scaling-audit', 'resources', {}]);
            expect(queryKeys.scalingAudit.events({ type: 'scale-up' })).toEqual([
                'scaling-audit', 'events', { type: 'scale-up' },
            ]);
            expect(queryKeys.scalingAudit.detail('e1')).toEqual(['scaling-audit', 'detail', 'e1']);
            expect(queryKeys.scalingAudit.summary()).toEqual(['scaling-audit', 'summary']);
            expect(queryKeys.scalingAudit.runs()).toEqual(['scaling-audit', 'runs', {}]);
            expect(queryKeys.scalingAudit.coverage()).toEqual(['scaling-audit', 'coverage']);
        });
    });

    describe('networkLinks', () => {
        it('builds the report key', () => {
            expect(queryKeys.networkLinks.report({ accountId: 'a1' })).toEqual([
                'network-links', 'report', { accountId: 'a1' },
            ]);
        });
    });

    describe('capacityPlanning', () => {
        it('builds summary/breaches/runs/resource keys', () => {
            expect(queryKeys.capacityPlanning.summary()).toEqual(['capacity-planning', 'summary', {}]);
            expect(queryKeys.capacityPlanning.breaches()).toEqual(['capacity-planning', 'breaches', {}]);
            expect(queryKeys.capacityPlanning.runs()).toEqual(['capacity-planning', 'runs', {}]);
            expect(queryKeys.capacityPlanning.resource('r1', { window: '1h' })).toEqual([
                'capacity-planning', 'resource', 'r1', { window: '1h' },
            ]);
        });
    });

    describe('spotGuard', () => {
        it('builds facets/services/detail/eligible/events/summary/report/settings keys', () => {
            expect(queryKeys.spotGuard.facets()).toEqual(['spot-guard', 'facets']);
            expect(queryKeys.spotGuard.services()).toEqual(['spot-guard', 'services', {}]);
            expect(queryKeys.spotGuard.detail('svc1')).toEqual(['spot-guard', 'detail', 'svc1']);
            expect(queryKeys.spotGuard.eligible()).toEqual(['spot-guard', 'eligible', {}]);
            expect(queryKeys.spotGuard.events()).toEqual(['spot-guard', 'events', {}]);
            expect(queryKeys.spotGuard.summary()).toEqual(['spot-guard', 'summary']);
            expect(queryKeys.spotGuard.report({ from: '2026-01-01' })).toEqual([
                'spot-guard', 'report', { from: '2026-01-01' },
            ]);
            expect(queryKeys.spotGuard.settings()).toEqual(['spot-guard', 'settings']);
        });
    });

    describe('certificates', () => {
        it('nests versions/accounts/accountDetail/executions/content under detail', () => {
            expect(queryKeys.certificates.detail('c1')).toEqual(['certificates', 'detail', 'c1']);
            expect(queryKeys.certificates.versions('c1')).toEqual(['certificates', 'detail', 'c1', 'versions']);
            expect(queryKeys.certificates.accounts('c1')).toEqual(['certificates', 'detail', 'c1', 'accounts']);
            expect(queryKeys.certificates.accountDetail('c1', 'a1')).toEqual([
                'certificates', 'detail', 'c1', 'account', 'a1',
            ]);
            expect(queryKeys.certificates.executions('c1')).toEqual(['certificates', 'detail', 'c1', 'executions']);
            expect(queryKeys.certificates.content('c1')).toEqual(['certificates', 'detail', 'c1', 'content', 'active']);
            expect(queryKeys.certificates.content('c1', 'v2')).toEqual(['certificates', 'detail', 'c1', 'content', 'v2']);
        });
    });

    describe('subagents', () => {
        it('builds the byThread key', () => {
            expect(queryKeys.subagents.byThread('t1')).toEqual(['subagents', 'thread', 't1']);
        });
    });

    describe('kbChat', () => {
        it('builds sessions/messages keys', () => {
            expect(queryKeys.kbChat.sessions()).toEqual(['kb-chat', 'sessions']);
            expect(queryKeys.kbChat.messages('s1')).toEqual(['kb-chat', 'messages', 's1']);
        });
    });

    describe('mcpServers', () => {
        it('builds the config key from the api path', () => {
            expect(queryKeys.mcpServers.config('/api/mcp-servers')).toEqual(['mcp-servers', '/api/mcp-servers']);
        });
    });

    describe('agentOps', () => {
        it('builds top-level and nested scheduledTasks keys', () => {
            expect(queryKeys.agentOps.list()).toEqual(['agent-ops', 'list', {}]);
            expect(queryKeys.agentOps.detail('run1')).toEqual(['agent-ops', 'detail', 'run1']);
            expect(queryKeys.agentOps.scheduledTasks.all).toEqual(['agent-ops', 'scheduled-tasks']);
            expect(queryKeys.agentOps.scheduledTasks.list()).toEqual(['agent-ops', 'scheduled-tasks', 'list', {}]);
            expect(queryKeys.agentOps.scheduledTasks.runs('task1', { status: 'failed' })).toEqual([
                'agent-ops', 'scheduled-tasks', 'runs', 'task1', { status: 'failed' },
            ]);
        });
    });

    describe('agentMemories', () => {
        it('builds list/detail keys', () => {
            expect(queryKeys.agentMemories.list()).toEqual(['agent-memories', 'list', {}]);
            expect(queryKeys.agentMemories.detail('m1')).toEqual(['agent-memories', 'detail', 'm1']);
        });
    });

    describe('skills', () => {
        it('coerces the all-filter to a boolean in the key', () => {
            expect(queryKeys.skills.list()).toEqual(['skills', 'list', { all: false }]);
            expect(queryKeys.skills.list(true)).toEqual(['skills', 'list', { all: true }]);
            expect(queryKeys.skills.detail('sk1')).toEqual(['skills', 'detail', 'sk1']);
        });
    });

    describe('threads', () => {
        it('builds the lists key', () => {
            expect(queryKeys.threads.lists()).toEqual(['threads', 'list']);
        });
    });

    describe('aiopsSettings', () => {
        it('builds the subagents key', () => {
            expect(queryKeys.aiopsSettings.subagents()).toEqual(['aiops-settings', 'subagents']);
        });
    });

    describe('ability', () => {
        it('builds the me key', () => {
            expect(queryKeys.ability.me()).toEqual(['ability', 'me']);
        });
    });

    describe('rbac', () => {
        it('builds registry/modules/actions/subjects/roles/role/routes/unmapped/denials/ledger/attrs keys', () => {
            expect(queryKeys.rbac.registry()).toEqual(['rbac', 'registry']);
            expect(queryKeys.rbac.modules()).toEqual(['rbac', 'modules']);
            expect(queryKeys.rbac.actions()).toEqual(['rbac', 'actions']);
            expect(queryKeys.rbac.subjects()).toEqual(['rbac', 'subjects']);
            expect(queryKeys.rbac.roles()).toEqual(['rbac', 'roles']);
            expect(queryKeys.rbac.role('r1')).toEqual(['rbac', 'roles', 'r1']);
            expect(queryKeys.rbac.routes()).toEqual(['rbac', 'routes']);
            expect(queryKeys.rbac.unmapped()).toEqual(['rbac', 'unmapped']);
            expect(queryKeys.rbac.denials()).toEqual(['rbac', 'denials', {}]);
            expect(queryKeys.rbac.ledger()).toEqual(['rbac', 'ledger', {}]);
            expect(queryKeys.rbac.principalAttributes()).toEqual(['rbac', 'principal-attrs']);
            expect(queryKeys.rbac.userAttributes('m1')).toEqual(['rbac', 'user-attrs', 'm1']);
        });
    });

    describe('dashboard', () => {
        it('builds hero/actionCenter/coverage/costAutomation/agentActivity/inventory/audit keys', () => {
            expect(queryKeys.dashboard.hero('7d')).toEqual(['dashboard', 'hero', '7d']);
            expect(queryKeys.dashboard.actionCenter('7d')).toEqual(['dashboard', 'action-center', '7d']);
            expect(queryKeys.dashboard.coverage()).toEqual(['dashboard', 'coverage']);
            expect(queryKeys.dashboard.costAutomation('7d')).toEqual(['dashboard', 'cost-automation', '7d']);
            expect(queryKeys.dashboard.agentActivity('7d')).toEqual(['dashboard', 'agent-activity', '7d']);
            expect(queryKeys.dashboard.inventory()).toEqual(['dashboard', 'inventory']);
            expect(queryKeys.dashboard.audit('7d')).toEqual(['dashboard', 'audit', '7d']);
        });
    });
});
