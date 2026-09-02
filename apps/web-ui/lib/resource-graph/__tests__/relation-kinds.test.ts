import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { kindOf, kindOrder, KIND_LABEL } from '../relation-kinds';

describe('kindOf', () => {
    it('classifies traffic-bearing relations', () => {
        expect(kindOf('routes_to_instance')).toBe('traffic');
        expect(kindOf('attached_to_load_balancer')).toBe('traffic');
        expect(kindOf('registers_with_target_group')).toBe('traffic');
        expect(kindOf('origin_is')).toBe('traffic');
        expect(kindOf('triggers')).toBe('traffic');
        expect(kindOf('invokes')).toBe('traffic');
        expect(kindOf('deploys_to')).toBe('traffic');
        expect(kindOf('notifies_on_event')).toBe('traffic');
    });

    it('classifies containment, attachment, reachability and observation', () => {
        expect(kindOf('in_vpc')).toBe('containment');
        expect(kindOf('has_volume')).toBe('attachment');
        expect(kindOf('allows_ingress_from')).toBe('reachability');
        expect(kindOf('monitors')).toBe('observation');
        expect(kindOf('sourced_from')).toBe('attachment');
        expect(kindOf('stores_artifacts_in')).toBe('attachment');
        expect(kindOf('runs_image_from')).toBe('attachment');
    });

    // Version skew: a deployed UI may read edges written by a newer worker.
    it('falls back to other for an unknown relation rather than dropping it', () => {
        expect(kindOf('teleports_to')).toBe('other');
    });
});

describe('kindOrder', () => {
    it('leads with traffic for dependents — the question is what breaks', () => {
        expect(kindOrder('dependents')[0]).toBe('traffic');
    });

    it('leads with containment for dependsOn — requirements read foundation-upward', () => {
        expect(kindOrder('dependsOn')[0]).toBe('containment');
    });

    it('ends both orders with other so unknowns sort last', () => {
        expect(kindOrder('dependents').at(-1)).toBe('other');
        expect(kindOrder('dependsOn').at(-1)).toBe('other');
    });

    it('includes every kind exactly once in both directions', () => {
        for (const dir of ['dependents', 'dependsOn'] as const) {
            const order = kindOrder(dir);
            expect(new Set(order).size).toBe(order.length);
            expect(new Set(order)).toEqual(new Set(Object.keys(KIND_LABEL)));
        }
    });
});

// Guard: EDGE_SPECS lives in apps/workers and there is no shared TS lib, so the
// completeness check reads the worker sources as text. See spec §9.
describe('coverage of the discovery relation vocabulary', () => {
    const WORKERS = join(__dirname, '../../../../workers/src/jobs/discovery/services');

    function relationsInSource(): string[] {
        const files = ['edge-spec.ts', 'edge-derivers.ts'];
        const found = new Set<string>();
        for (const file of files) {
            const src = readFileSync(join(WORKERS, file), 'utf-8');
            for (const m of src.matchAll(/relation:\s*'([a-z_]+)'/g)) found.add(m[1]);
        }
        return [...found].sort();
    }

    it('finds the vocabulary (guards the regex itself)', () => {
        const relations = relationsInSource();
        expect(relations.length).toBeGreaterThan(20);
        expect(relations).toContain('in_vpc');
    });

    it('classifies every relation discovery can emit', () => {
        const unmapped = relationsInSource().filter((r) => kindOf(r) === 'other');
        expect(unmapped, `unclassified relations: ${unmapped.join(', ')}`).toEqual([]);
    });
});
