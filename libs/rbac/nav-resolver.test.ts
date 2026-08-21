import { describe, expect, it } from 'vitest';

import { resolveNavOwner } from './nav-resolver';

const SUBJECTS = [
    { key: 'Agent', navPath: '/app/agent' },
    { key: 'AgentOps', navPath: '/app/agent-ops' },
    { key: 'Provider', navPath: '/app/agent-ops/providers' },
    { key: 'Channel', navPath: '/app/channels' },
    { key: 'Discovery', navPath: null },
];

const MODULES = [
    { key: 'AIOps', navPath: '/app/agent' },
    { key: 'Settings', navPath: '/app/settings' },
];

describe('resolveNavOwner', () => {
    it('picks the longest matching navPath', () => {
        expect(resolveNavOwner('/app/agent-ops/providers', SUBJECTS, MODULES)).toEqual({
            kind: 'subject',
            key: 'Provider',
            navPath: '/app/agent-ops/providers',
        });
    });

    it('matches a child route through its parent prefix', () => {
        expect(resolveNavOwner('/app/channels/telegram-settings', SUBJECTS, MODULES)?.key).toBe('Channel');
    });

    // The trap: '/app/agent-ops' must NOT be treated as a child of '/app/agent'.
    // The `+ '/'` in the prefix test is the only thing preventing it, and getting
    // this wrong silently gates all of Agent Ops behind the Agent subject.
    it('does not treat a longer sibling segment as a child', () => {
        expect(resolveNavOwner('/app/agent-ops', SUBJECTS, MODULES)?.key).toBe('AgentOps');
    });

    // Subject and module both sit on '/app/agent'. Without the tie-break the
    // module wins and the Agent subject can never gate the AI Ops page.
    it('prefers a subject over a module at equal navPath length', () => {
        expect(resolveNavOwner('/app/agent', SUBJECTS, MODULES)).toEqual({
            kind: 'subject',
            key: 'Agent',
            navPath: '/app/agent',
        });
    });

    it('falls back to a module when no subject claims the path', () => {
        expect(resolveNavOwner('/app/settings/organization', SUBJECTS, MODULES)).toEqual({
            kind: 'module',
            key: 'Settings',
            navPath: '/app/settings',
        });
    });

    it('returns null when nothing claims the path', () => {
        expect(resolveNavOwner('/app/nowhere', SUBJECTS, MODULES)).toBeNull();
    });

    it('ignores rows with a null navPath', () => {
        expect(resolveNavOwner('/app/discovery', SUBJECTS, MODULES)).toBeNull();
    });

    it('is deterministic when two rows of the same kind tie', () => {
        const dupes = [
            { key: 'Bbb', navPath: '/app/dupe' },
            { key: 'Aaa', navPath: '/app/dupe' },
        ];
        expect(resolveNavOwner('/app/dupe', dupes, [])?.key).toBe('Aaa');
    });
});
