import { describe, expect, it } from 'vitest';

import {
    filterToLegacyModules,
    LEGACY_MODULES,
    normalizeGrants,
    resolveSubjectModuleMap,
    type RuleTarget,
    type SubjectModuleRow,
} from './parity-normalize';

describe('LEGACY_MODULES', () => {
    it('is exactly the seven modules the legacy matrix can express', () => {
        expect([...LEGACY_MODULES].sort()).toEqual([
            'AIOps',
            'Accounts',
            'Dashboard',
            'IAM',
            'Inventory',
            'Schedules',
            'Settings',
        ]);
    });
});

describe('resolveSubjectModuleMap', () => {
    it('maps each subject key to its module key', () => {
        const rows: SubjectModuleRow[] = [
            { subjectKey: 'Agent', moduleKey: 'AIOps', tenantId: null },
            { subjectKey: 'Schedule', moduleKey: 'Schedules', tenantId: null },
        ];

        expect(resolveSubjectModuleMap(rows)).toEqual({
            Agent: 'AIOps',
            Schedule: 'Schedules',
        });
    });

    it('lets a tenant-local link shadow the global link for the same subject', () => {
        // A remap writes a tenant-local row while the global row survives, so both
        // are visible to the reader and precedence must be explicit.
        const rows: SubjectModuleRow[] = [
            { subjectKey: 'Agent', moduleKey: 'AIOps', tenantId: null },
            { subjectKey: 'Agent', moduleKey: 'Settings', tenantId: 'tenant-1' },
        ];

        expect(resolveSubjectModuleMap(rows)).toEqual({ Agent: 'Settings' });
    });

    it('applies that precedence regardless of row order', () => {
        const rows: SubjectModuleRow[] = [
            { subjectKey: 'Agent', moduleKey: 'Settings', tenantId: 'tenant-1' },
            { subjectKey: 'Agent', moduleKey: 'AIOps', tenantId: null },
        ];

        expect(resolveSubjectModuleMap(rows)).toEqual({ Agent: 'Settings' });
    });
});

describe('normalizeGrants', () => {
    const subjectToModule = { Agent: 'AIOps', Schedule: 'Schedules' };

    it('keys a module-targeted rule by its module', () => {
        const rules: RuleTarget[] = [
            { action: 'read', moduleKey: 'Schedules', subjectKey: null, inverted: false },
        ];

        const result = normalizeGrants(rules, subjectToModule);

        expect([...result.inScope]).toEqual(['Schedules:read']);
        expect(result.outOfScope).toEqual([]);
        expect(result.unmappedSubjects).toEqual([]);
    });

    it('rewrites a subject-targeted rule onto its owning module', () => {
        // This is the whole point: Agent:read and AIOps:read are the same grant.
        const rules: RuleTarget[] = [
            { action: 'read', moduleKey: null, subjectKey: 'Agent', inverted: false },
        ];

        expect([...normalizeGrants(rules, subjectToModule).inScope]).toEqual(['AIOps:read']);
    });

    it('collapses a module rule and a subject rule that mean the same thing', () => {
        const rules: RuleTarget[] = [
            { action: 'read', moduleKey: 'AIOps', subjectKey: null, inverted: false },
            { action: 'read', moduleKey: null, subjectKey: 'Agent', inverted: false },
        ];

        expect([...normalizeGrants(rules, subjectToModule).inScope]).toEqual(['AIOps:read']);
    });

    it('ignores inverted rules, which are denials rather than grants', () => {
        const rules: RuleTarget[] = [
            { action: 'delete', moduleKey: 'Settings', subjectKey: null, inverted: true },
        ];

        const result = normalizeGrants(rules, subjectToModule);

        expect([...result.inScope]).toEqual([]);
        expect(result.outOfScope).toEqual([]);
    });

    it('separates grants on modules outside the legacy taxonomy', () => {
        // A tenant-authored module is new capability, not a parity violation.
        const rules: RuleTarget[] = [
            { action: 'read', moduleKey: 'TampModule', subjectKey: null, inverted: false },
            { action: 'read', moduleKey: 'Settings', subjectKey: null, inverted: false },
        ];

        const result = normalizeGrants(rules, subjectToModule);

        expect([...result.inScope]).toEqual(['Settings:read']);
        expect(result.outOfScope).toEqual(['TampModule:read']);
    });

    it('reports a subject with no module link instead of dropping it silently', () => {
        const rules: RuleTarget[] = [
            { action: 'read', moduleKey: null, subjectKey: 'Orphan', inverted: false },
        ];

        const result = normalizeGrants(rules, subjectToModule);

        expect([...result.inScope]).toEqual([]);
        expect(result.unmappedSubjects).toEqual(['Orphan']);
    });

    it('returns outOfScope and unmappedSubjects sorted and deduplicated', () => {
        const rules: RuleTarget[] = [
            { action: 'read', moduleKey: 'Zeta', subjectKey: null, inverted: false },
            { action: 'read', moduleKey: 'Alpha', subjectKey: null, inverted: false },
            { action: 'read', moduleKey: 'Zeta', subjectKey: null, inverted: false },
            { action: 'read', moduleKey: null, subjectKey: 'Orphan', inverted: false },
            { action: 'update', moduleKey: null, subjectKey: 'Orphan', inverted: false },
        ];

        const result = normalizeGrants(rules, subjectToModule);

        expect(result.outOfScope).toEqual(['Alpha:read', 'Zeta:read']);
        expect(result.unmappedSubjects).toEqual(['Orphan']);
    });
});

describe('filterToLegacyModules', () => {
    it('keeps only keys whose module is in the legacy taxonomy', () => {
        const kept = filterToLegacyModules([
            'Settings:read',
            'TampModule:read',
            'AIOps:create',
        ]);

        expect([...kept].sort()).toEqual(['AIOps:create', 'Settings:read']);
    });

    it('tolerates an action containing a colon by splitting on the first only', () => {
        expect([...filterToLegacyModules(['Settings:weird:verb'])]).toEqual([
            'Settings:weird:verb',
        ]);
    });
});
