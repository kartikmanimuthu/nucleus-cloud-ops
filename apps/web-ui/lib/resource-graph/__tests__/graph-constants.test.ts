import { describe, it, expect } from 'vitest';
import {
    SEED_NODE_CAP,
    SEED_EDGE_CAP,
    STRUCTURAL_TYPES,
    HIDDEN_NODE_TYPES,
    OBSERVATION_RELATIONS,
    isHiddenType,
} from '../graph-constants';

describe('graph constants', () => {
    it('hides the two types that make up 59% of inventory', () => {
        expect(HIDDEN_NODE_TYPES).toContain('ssm_parameters');
        expect(HIDDEN_NODE_TYPES).toContain('iam_roles');
    });

    it('treats a hidden type as visible once the caller opts in', () => {
        expect(isHiddenType('iam_roles', {})).toBe(true);
        expect(isHiddenType('iam_roles', { includeHiddenTypes: true })).toBe(false);
        expect(isHiddenType('ec2_instances', {})).toBe(false);
    });

    it('lists only structural types, never leaf types', () => {
        expect(STRUCTURAL_TYPES).toContain('ec2_vpcs');
        expect(STRUCTURAL_TYPES).toContain('elbv2_load_balancers');
        expect(STRUCTURAL_TYPES).not.toContain('ec2_instances');
        expect(STRUCTURAL_TYPES).not.toContain('ec2_volumes');
    });

    it('caps the seed below the measured p90 account size with headroom', () => {
        expect(SEED_NODE_CAP).toBeGreaterThan(970);
    });

    it('caps seed edges above the largest measured account', () => {
        expect(SEED_EDGE_CAP).toBeGreaterThan(1725);
    });

    it('classes both observation relations together', () => {
        expect([...OBSERVATION_RELATIONS].sort()).toEqual(['monitors', 'notifies']);
    });
});
