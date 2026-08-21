import { describe, it, expect } from 'vitest';
import { isCapacityRelevantDocDbEvent, docDbEventActivityId, DOCDB_EVENTS_RETENTION_DAYS } from './docdb-events-client.js';

describe('isCapacityRelevantDocDbEvent — decided scope filter', () => {
    it('keeps a finished instance-class modification', () => {
        expect(
            isCapacityRelevantDocDbEvent({ SourceType: 'db-instance', Message: 'Finished applying modification to an instance class.', EventCategories: ['configuration change'] })
        ).toBe(true);
    });

    it('keeps instance creation and deletion (candidate replica add/remove — see docdb-cloudtrail-client.ts for the primary-vs-replica ambiguity)', () => {
        expect(isCapacityRelevantDocDbEvent({ SourceType: 'db-instance', Message: 'Instance created.', EventCategories: ['creation'] })).toBe(true);
        expect(isCapacityRelevantDocDbEvent({ SourceType: 'db-instance', Message: 'Instance deleted', EventCategories: ['deletion'] })).toBe(true);
    });

    it('drops the START-of-change message to avoid a duplicate pair of rows for one logical change', () => {
        expect(
            isCapacityRelevantDocDbEvent({ SourceType: 'db-instance', Message: 'Applying modification to an instance class.', EventCategories: ['configuration change'] })
        ).toBe(false);
    });

    it('drops a configuration-change message that is not a scaling action', () => {
        expect(isCapacityRelevantDocDbEvent({ SourceType: 'db-instance', Message: 'Reset primary credentials.', EventCategories: ['configuration change'] })).toBe(false);
    });

    it('drops non-instance source types — no cluster-level event qualifies under the decided scope', () => {
        expect(isCapacityRelevantDocDbEvent({ SourceType: 'db-cluster', Message: 'Cluster created', EventCategories: ['creation'] })).toBe(false);
    });

    it('drops availability/notification/recovery noise even for a db-instance source — re-checked here even though the request already filters server-side by EventCategories', () => {
        expect(isCapacityRelevantDocDbEvent({ SourceType: 'db-instance', Message: 'Instance stopped.', EventCategories: ['notification'] })).toBe(false);
        expect(isCapacityRelevantDocDbEvent({ SourceType: 'db-instance', Message: 'The instance restarted.', EventCategories: ['availability'] })).toBe(false);
    });

    it('drops an event with no message', () => {
        expect(isCapacityRelevantDocDbEvent({ SourceType: 'db-instance', Message: undefined, EventCategories: ['creation'] })).toBe(false);
    });

    it('drops an event with no EventCategories at all', () => {
        expect(isCapacityRelevantDocDbEvent({ SourceType: 'db-instance', Message: 'Instance created.', EventCategories: undefined })).toBe(false);
    });
});

describe('docDbEventActivityId — synthesized dedup key', () => {
    // DescribeEvents has no stable per-event ID, unlike ASG's ActivityId or
    // CloudTrail's eventID — this hash is the only thing standing between a
    // re-poll (with the watermark overlap window) and duplicate rows.
    const date = new Date('2026-08-05T16:00:00Z');

    it('is stable for the same (source, message, timestamp) triple', () => {
        const a = docDbEventActivityId('my-instance', 'Finished applying modification to an instance class.', date);
        const b = docDbEventActivityId('my-instance', 'Finished applying modification to an instance class.', date);
        expect(a).toBe(b);
    });

    it('differs when the instance identifier differs', () => {
        const a = docDbEventActivityId('instance-a', 'Instance created.', date);
        const b = docDbEventActivityId('instance-b', 'Instance created.', date);
        expect(a).not.toBe(b);
    });

    it('differs when the message differs', () => {
        const a = docDbEventActivityId('my-instance', 'Instance created.', date);
        const b = docDbEventActivityId('my-instance', 'Instance deleted', date);
        expect(a).not.toBe(b);
    });

    it('differs when the timestamp differs', () => {
        const a = docDbEventActivityId('my-instance', 'Instance created.', date);
        const b = docDbEventActivityId('my-instance', 'Instance created.', new Date('2026-08-05T16:00:01Z'));
        expect(a).not.toBe(b);
    });
});

describe('DOCDB_EVENTS_RETENTION_DAYS', () => {
    // Documents the AWS-imposed ceiling this client clamps to — far short of
    // SCALING_AUDIT_CONFIG.awsRetentionDays (38d), which describes ASG/AAS only.
    it('is 14 days, per the DescribeEvents API docs', () => {
        expect(DOCDB_EVENTS_RETENTION_DAYS).toBe(14);
    });
});
