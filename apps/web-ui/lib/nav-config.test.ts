import { describe, it, expect } from 'vitest';
import { getPageTitle } from '@/lib/nav-config';

describe('getPageTitle', () => {
    it('matches an exact top-level href', () => {
        expect(getPageTitle('/app/dashboard')).toBe('Dashboard');
    });

    it('matches a sub-path via prefix', () => {
        expect(getPageTitle('/app/accounts/acc-123')).toBe('AWS Accounts');
    });

    it('picks the longest matching href when multiple candidates match', () => {
        // /app/agent-ops/scheduled-tasks and /app/agent-ops both match a
        // /app/agent-ops/scheduled-tasks/foo pathname; the longer one must win.
        expect(getPageTitle('/app/agent-ops/scheduled-tasks/task-1')).toBe('Scheduled Tasks');
    });

    it('falls back to the product name for an unrecognized pathname', () => {
        expect(getPageTitle('/does/not/exist')).toBe('Nucleus Cloud Ops');
    });

    it('does not match a pathname that merely starts with the same characters, not the same path segment', () => {
        // '/app/agent-ops-extra' starts with '/app/agent-ops' as a raw string but
        // is not the same route — the trailing-slash check must reject it.
        expect(getPageTitle('/app/agent-ops-extra')).toBe('Nucleus Cloud Ops');
    });
});
