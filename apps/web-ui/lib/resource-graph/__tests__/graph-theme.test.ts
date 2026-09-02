import { describe, it, expect } from 'vitest';
import { colorForType, RESOURCE_TYPE_COLORS, NODE_KIND } from '../graph-theme';

describe('graph theme', () => {
    it('gives the common AWS types distinct colours', () => {
        const types = ['ec2_instances', 'rds_db_instances', 's3_buckets', 'ec2_vpcs', 'lambda_functions'];
        expect(new Set(types.map(colorForType)).size).toBe(types.length);
    });

    it('falls back to a neutral colour for an unknown type rather than throwing', () => {
        expect(colorForType('some_future_service')).toBe(RESOURCE_TYPE_COLORS.__fallback);
    });

    it('marks synthetic nodes distinctly from discovered resources', () => {
        expect(NODE_KIND.account).not.toBe(NODE_KIND.resource);
        expect(NODE_KIND.hub).not.toBe(NODE_KIND.resource);
    });
});
