import { describe, it, expect } from 'vitest';
import { isStorageAutoscalingCompletion, rdsEventActivityId } from './rds-events-client.js';

describe('isStorageAutoscalingCompletion — RDS-EVENT-0218 only, never its neighbors', () => {
    it('matches the real AWS completion message (RDS-EVENT-0218)', () => {
        expect(isStorageAutoscalingCompletion({ Message: 'Finished applying autoscaling-initiated modification to allocated storage.' })).toBe(true);
    });

    it('is tolerant of surrounding whitespace', () => {
        expect(isStorageAutoscalingCompletion({ Message: '  Finished applying autoscaling-initiated modification to allocated storage.  ' })).toBe(true);
    });

    it('rejects the in-progress counterpart (RDS-EVENT-0217) — same operation, not yet done', () => {
        expect(isStorageAutoscalingCompletion({ Message: 'Applying autoscaling-initiated modification to allocated storage.' })).toBe(false);
    });

    it('rejects a MANUAL storage modification (RDS-EVENT-0017/0018) — no "autoscaling" in the text', () => {
        expect(isStorageAutoscalingCompletion({ Message: 'Finished applying modification to allocated storage.' })).toBe(false);
    });

    it('rejects a storage-autoscaling FAILURE (RDS-EVENT-0223) — out of scope, and not "Finished"', () => {
        expect(isStorageAutoscalingCompletion({ Message: 'Storage autoscaling is unable to scale the storage for the reason: some-reason' })).toBe(false);
    });

    it('rejects an unrelated configuration-change message', () => {
        expect(isStorageAutoscalingCompletion({ Message: 'Finished applying modification to DB instance class.' })).toBe(false);
    });

    it('is false for a missing message rather than throwing', () => {
        expect(isStorageAutoscalingCompletion({})).toBe(false);
    });
});

describe('rdsEventActivityId — stable dedup key for an API with no per-event ID', () => {
    const date = new Date('2026-08-15T10:00:00.000Z');

    it('is deterministic for the same (instance, message, date)', () => {
        const a = rdsEventActivityId('mydb', 'Finished applying autoscaling-initiated modification to allocated storage.', date);
        const b = rdsEventActivityId('mydb', 'Finished applying autoscaling-initiated modification to allocated storage.', date);
        expect(a).toBe(b);
    });

    it('differs when the instance identifier differs', () => {
        const msg = 'Finished applying autoscaling-initiated modification to allocated storage.';
        expect(rdsEventActivityId('mydb', msg, date)).not.toBe(rdsEventActivityId('other-db', msg, date));
    });

    it('differs when the timestamp differs — distinct occurrences of the identical message must not collide', () => {
        const msg = 'Finished applying autoscaling-initiated modification to allocated storage.';
        const later = new Date('2026-08-16T10:00:00.000Z');
        expect(rdsEventActivityId('mydb', msg, date)).not.toBe(rdsEventActivityId('mydb', msg, later));
    });
});
