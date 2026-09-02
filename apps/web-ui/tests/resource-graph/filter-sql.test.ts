import { describe, it, expect } from 'vitest';
import { edgeFilterSql, nodeTypeFilterSql } from '@/lib/db/repositories/resource-graph/filter-sql';

describe('edgeFilterSql', () => {
    it('excludes AWS-managed key aliases by default', () => {
        expect(edgeFilterSql('e', {})).toContain(`'alias/aws/%'`);
    });

    it('drops the key predicate when the caller opts in', () => {
        expect(edgeFilterSql('e', { includeAwsManagedKeys: true })).not.toContain(`'alias/aws/%'`);
    });

    it('includes observation edges by default so alarm relationships are visible', () => {
        expect(edgeFilterSql('e', {})).not.toContain('monitors');
        expect(edgeFilterSql('e', { includeObservation: false })).toContain('monitors');
    });

    it('qualifies every predicate with the given alias', () => {
        const sql = edgeFilterSql('xyz', {});
        expect(sql).toContain('xyz."toType"');
        expect(sql).not.toContain('e."toType"');
    });

    it('returns an empty string when every filter is disabled', () => {
        expect(edgeFilterSql('e', {
            includeAwsManagedKeys: true,
            includeObservation: true,
        })).toBe('');
    });
});

describe('nodeTypeFilterSql', () => {
    it('excludes hidden types by default', () => {
        const sql = nodeTypeFilterSql('i', {});
        expect(sql).toContain('ssm_parameters');
        expect(sql).toContain('iam_roles');
        expect(sql).toContain('i."resourceType"');
    });

    it('returns an empty string when hidden types are included', () => {
        expect(nodeTypeFilterSql('i', { includeHiddenTypes: true })).toBe('');
    });
});
