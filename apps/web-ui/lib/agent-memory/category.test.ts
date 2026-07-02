import { describe, it, expect } from 'vitest';
import { categoryFromNamespace, KNOWN_CATEGORIES } from './category';

describe('categoryFromNamespace', () => {
    it('maps known first segments to their category', () => {
        expect(categoryFromNamespace('infra/acct-123')).toBe('infra');
        expect(categoryFromNamespace('user/preferences')).toBe('user');
        expect(categoryFromNamespace('patterns/ecs')).toBe('patterns');
        expect(categoryFromNamespace('errors/rds')).toBe('errors');
        expect(categoryFromNamespace('episodes')).toBe('episodes');
        expect(categoryFromNamespace('procedures/aws-cli')).toBe('procedures');
    });

    it('is case-insensitive on the first segment', () => {
        expect(categoryFromNamespace('INFRA/x')).toBe('infra');
    });

    it('matches a bare segment with no slash', () => {
        expect(categoryFromNamespace('user')).toBe('user');
    });

    it('falls back to "other" for unknown or empty namespaces', () => {
        expect(categoryFromNamespace('billing/x')).toBe('other');
        expect(categoryFromNamespace('')).toBe('other');
    });

    it('exposes the known categories in display order', () => {
        expect(KNOWN_CATEGORIES).toEqual(['infra', 'user', 'patterns', 'errors', 'episodes', 'procedures']);
    });
});
