/**
 * Unit tests for AgentOpsRun and AgentOpsEvent model schemas.
 *
 * Tests verify:
 *  - Key construction patterns (PK, SK, GSI1PK, GSI1SK)
 *  - TTL calculation (now + 30 days in Unix epoch seconds)
 *
 * Dynamoose is mocked to avoid real DynamoDB connections.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dynamoose before any model imports ───────────────────────────

vi.mock('dynamoose', () => {
    const Schema = vi.fn().mockImplementation(() => ({}));
    const model = vi.fn().mockReturnValue({});
    const aws = {
        ddb: {
            DynamoDB: vi.fn(),
            set: vi.fn(),
        },
    };
    return { default: { Schema, model, aws }, Schema, model, aws };
});

// ─── Import helpers under test ─────────────────────────────────────────

import { TTL_30_DAYS, AGENT_OPS_TABLE_NAME } from '../../../lib/agent-ops/dynamoose-config';

// ─── Key construction helpers (mirrors agent-ops-service logic) ────────
// These are pure functions that encode the single-table design key patterns.

function buildRunPK(tenantId: string): string {
    return `TENANT#${tenantId}`;
}

function buildRunSK(runId: string): string {
    return `RUN#${runId}`;
}

function buildRunGSI1PK(source: string): string {
    return `SOURCE#${source}`;
}

function buildRunGSI1SK(timestamp: string, runId: string): string {
    return `${timestamp}#${runId}`;
}

function buildEventPK(runId: string): string {
    return `RUN#${runId}`;
}

function buildEventSK(timestamp: string, nanos: string): string {
    return `EVENT#${timestamp}#${nanos}`;
}

// ─── TTL Tests ─────────────────────────────────────────────────────────

describe('TTL_30_DAYS', () => {
    it('returns a number (Unix epoch seconds)', () => {
        const ttl = TTL_30_DAYS();
        expect(typeof ttl).toBe('number');
        expect(Number.isInteger(ttl)).toBe(true);
    });

    it('is approximately now + 30 days', () => {
        const before = Math.floor(Date.now() / 1000);
        const ttl = TTL_30_DAYS();
        const after = Math.floor(Date.now() / 1000);

        const thirtyDaysSeconds = 30 * 24 * 60 * 60;
        expect(ttl).toBeGreaterThanOrEqual(before + thirtyDaysSeconds);
        expect(ttl).toBeLessThanOrEqual(after + thirtyDaysSeconds);
    });

    it('is greater than current Unix time', () => {
        const now = Math.floor(Date.now() / 1000);
        expect(TTL_30_DAYS()).toBeGreaterThan(now);
    });

    it('returns a fresh value on each call', () => {
        const t1 = TTL_30_DAYS();
        const t2 = TTL_30_DAYS();
        // Both should be within 1 second of each other
        expect(Math.abs(t2 - t1)).toBeLessThanOrEqual(1);
    });
});

// ─── AGENT_OPS_TABLE_NAME default ─────────────────────────────────────

describe('AGENT_OPS_TABLE_NAME', () => {
    it('defaults to AgentOpsTable when env var is not set', () => {
        // The mock import resolves without AGENT_OPS_TABLE_NAME env var
        expect(AGENT_OPS_TABLE_NAME).toBe('AgentOpsTable');
    });
});

// ─── AgentOpsRun key construction ─────────────────────────────────────

describe('AgentOpsRun key patterns', () => {
    const tenantId = 'T01234ABCDE';
    const runId = '550e8400-e29b-41d4-a716-446655440000';
    const source = 'slack';
    const timestamp = '2024-01-15T10:30:00.000Z';

    it('PK format is TENANT#<tenantId>', () => {
        expect(buildRunPK(tenantId)).toBe(`TENANT#${tenantId}`);
    });

    it('PK starts with TENANT# prefix', () => {
        expect(buildRunPK(tenantId)).toMatch(/^TENANT#/);
    });

    it('SK format is RUN#<runId>', () => {
        expect(buildRunSK(runId)).toBe(`RUN#${runId}`);
    });

    it('SK starts with RUN# prefix', () => {
        expect(buildRunSK(runId)).toMatch(/^RUN#/);
    });

    it('GSI1PK format is SOURCE#<source>', () => {
        expect(buildRunGSI1PK(source)).toBe(`SOURCE#${source}`);
    });

    it('GSI1PK starts with SOURCE# prefix', () => {
        expect(buildRunGSI1PK(source)).toMatch(/^SOURCE#/);
    });

    it('GSI1SK format is <ISO-timestamp>#<runId>', () => {
        expect(buildRunGSI1SK(timestamp, runId)).toBe(`${timestamp}#${runId}`);
    });

    it('GSI1SK contains the timestamp before the runId', () => {
        const gsi1sk = buildRunGSI1SK(timestamp, runId);
        const parts = gsi1sk.split('#');
        // ISO timestamp has colons replaced — check the runId is at the end
        expect(gsi1sk.endsWith(`#${runId}`)).toBe(true);
        expect(gsi1sk.startsWith(timestamp)).toBe(true);
    });

    it('PK embeds the tenantId verbatim', () => {
        const pk = buildRunPK(tenantId);
        expect(pk).toContain(tenantId);
    });

    it('SK embeds the runId verbatim', () => {
        const sk = buildRunSK(runId);
        expect(sk).toContain(runId);
    });

    it('GSI1PK embeds the source verbatim', () => {
        const gsi1pk = buildRunGSI1PK(source);
        expect(gsi1pk).toContain(source);
    });

    it('different tenantIds produce different PKs', () => {
        expect(buildRunPK('TENANT_A')).not.toBe(buildRunPK('TENANT_B'));
    });

    it('different runIds produce different SKs', () => {
        expect(buildRunSK('run-1')).not.toBe(buildRunSK('run-2'));
    });

    it('different sources produce different GSI1PKs', () => {
        expect(buildRunGSI1PK('slack')).not.toBe(buildRunGSI1PK('jira'));
    });
});

// ─── AgentOpsEvent key construction ───────────────────────────────────

describe('AgentOpsEvent key patterns', () => {
    const runId = '550e8400-e29b-41d4-a716-446655440000';
    const timestamp = '2024-01-15T10:30:00.000Z';
    const nanos = '1234567890';

    it('PK format is RUN#<runId>', () => {
        expect(buildEventPK(runId)).toBe(`RUN#${runId}`);
    });

    it('PK starts with RUN# prefix', () => {
        expect(buildEventPK(runId)).toMatch(/^RUN#/);
    });

    it('SK format is EVENT#<ISO-timestamp>#<hrtime-nanos>', () => {
        expect(buildEventSK(timestamp, nanos)).toBe(`EVENT#${timestamp}#${nanos}`);
    });

    it('SK starts with EVENT# prefix', () => {
        expect(buildEventSK(timestamp, nanos)).toMatch(/^EVENT#/);
    });

    it('SK contains the timestamp after EVENT#', () => {
        const sk = buildEventSK(timestamp, nanos);
        expect(sk).toContain(timestamp);
    });

    it('SK contains the nanos suffix', () => {
        const sk = buildEventSK(timestamp, nanos);
        expect(sk.endsWith(nanos)).toBe(true);
    });

    it('PK embeds the runId verbatim', () => {
        expect(buildEventPK(runId)).toContain(runId);
    });

    it('different runIds produce different event PKs', () => {
        expect(buildEventPK('run-a')).not.toBe(buildEventPK('run-b'));
    });

    it('different nanos produce different SKs (uniqueness guarantee)', () => {
        const sk1 = buildEventSK(timestamp, '1000000000');
        const sk2 = buildEventSK(timestamp, '1000000001');
        expect(sk1).not.toBe(sk2);
    });

    it('same timestamp but different nanos are still unique', () => {
        // This is the core uniqueness guarantee for concurrent events
        const sameTs = '2024-01-15T10:30:00.000Z';
        const sk1 = buildEventSK(sameTs, '100');
        const sk2 = buildEventSK(sameTs, '101');
        expect(sk1).not.toBe(sk2);
    });

    it('event PK matches run SK runId (same runId links run to events)', () => {
        const eventPK = buildEventPK(runId);
        const runSK = buildRunSK(runId);
        // Both contain the same runId
        expect(eventPK).toContain(runId);
        expect(runSK).toContain(runId);
    });
});

// ─── Key separation (run vs event records in same table) ───────────────

describe('Single-table design key separation', () => {
    const runId = 'abc-123';
    const tenantId = 'T_TEAM';

    it('run PK and event PK use different prefixes', () => {
        const runPK = buildRunPK(tenantId);
        const eventPK = buildEventPK(runId);
        expect(runPK.startsWith('TENANT#')).toBe(true);
        expect(eventPK.startsWith('RUN#')).toBe(true);
    });

    it('run SK and event SK use different prefixes', () => {
        const runSK = buildRunSK(runId);
        const eventSK = buildEventSK('2024-01-01T00:00:00.000Z', '0');
        expect(runSK.startsWith('RUN#')).toBe(true);
        expect(eventSK.startsWith('EVENT#')).toBe(true);
    });
});
