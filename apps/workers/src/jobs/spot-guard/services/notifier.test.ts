// workers/src/jobs/spot-guard/services/notifier.test.ts
//
// The behaviours worth pinning down here are all about what must NOT happen:
//   * the event row must never be suppressed by the alert-dedup window;
//   * a Slack failure must never propagate to the caller (a remediation job);
//   * an unconfigured relay must be quiet, not noisy.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { writeEvent, markEventNotified, claimAlertWindow, writeAuditLog } = vi.hoisted(() => ({
    writeEvent: vi.fn(),
    markEventNotified: vi.fn(),
    claimAlertWindow: vi.fn(),
    writeAuditLog: vi.fn(),
}));

vi.mock('./db-writer.js', async () => {
    const actual = await vi.importActual<typeof import('./db-writer.js')>('./db-writer.js');
    return { ...actual, writeEvent, markEventNotified };
});
vi.mock('./dedup.js', async () => {
    const actual = await vi.importActual<typeof import('./dedup.js')>('./dedup.js');
    return { ...actual, claimAlertWindow };
});
vi.mock('../../discovery/services/audit-service.js', () => ({ writeAuditLog }));

const base = {
    tenantId: 'tenant-a',
    accountId: '111111111111',
    region: 'ap-south-1',
    clusterName: 'cluster-a',
    serviceName: 'api',
    message: 'something happened',
} as const;

const originalEnv = { ...process.env };

beforeEach(() => {
    vi.clearAllMocks();
    // Reset the module registry on EVERY test, not just the one that manipulates env vars.
    // env.ts snapshots process.env via createEnv at module load, so without this a test that
    // changes an env var leaks a stale snapshot into whichever test imports next — which is
    // an ordering dependency that fails confusingly rather than obviously.
    vi.resetModules();
    writeEvent.mockResolvedValue('event-1');
    markEventNotified.mockResolvedValue(undefined);
    claimAlertWindow.mockResolvedValue({ granted: true, windowEndsAt: new Date(), suppressedCount: 0 });
    writeAuditLog.mockResolvedValue(undefined);
    // Relay configured by default so the fetch path is exercised.
    process.env.WEB_UI_BASE_URL = 'https://nucleus.test';
    process.env.INTERNAL_API_KEY = 'test-key';
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ success: true, data: { delivered: true } }), { status: 200 })),
    );
});

afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
});

describe('notify — the event row is never gated by dedup', () => {
    it('writes the event even when the Slack window is already claimed', async () => {
        // THE rule. The reference throttled the alert itself, which was fine with no UI. Here
        // the event row is the product surface, and suppressing rows would punch holes in the
        // timeline during exactly the incident an operator is looking at.
        claimAlertWindow.mockResolvedValue({ granted: false, windowEndsAt: new Date(), suppressedCount: 3 });
        const { notify } = await import('./notifier.js');

        const res = await notify({ ...base, eventType: 'interruption', alertType: 'interruption' });

        expect(writeEvent).toHaveBeenCalledTimes(1);
        expect(res.eventId).toBe('event-1');
        expect(res.slackDelivered).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('records the suppression on the row so the UI can show it', async () => {
        claimAlertWindow.mockResolvedValue({ granted: false, windowEndsAt: new Date(), suppressedCount: 1 });
        const { notify } = await import('./notifier.js');

        await notify({ ...base, eventType: 'interruption', alertType: 'interruption' });

        expect(markEventNotified).toHaveBeenCalledWith(
            expect.objectContaining({ eventId: 'event-1', notified: false, suppressedByDedup: true }),
        );
    });

    it('writes the event and skips Slack entirely when no alertType is given', async () => {
        // Timeline-only event types (governance_skip, backoff_skip, alb_predrain) must not
        // consume a dedup window or send anything.
        const { notify } = await import('./notifier.js');
        const res = await notify({ ...base, eventType: 'governance_skip' });

        expect(writeEvent).toHaveBeenCalledTimes(1);
        expect(claimAlertWindow).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(res.slackDelivered).toBe(false);
    });
});

describe('notify — Slack delivery', () => {
    it('relays with the internal key and tenant headers', async () => {
        const { notify } = await import('./notifier.js');
        await notify({ ...base, eventType: 'interruption', alertType: 'interruption', slackText: 'hello' });

        expect(fetch).toHaveBeenCalledWith(
            'https://nucleus.test/api/internal/spot-guard/notify',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'x-internal-key': 'test-key', 'x-tenant-id': 'tenant-a' }),
            }),
        );
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body.text).toBe('hello');
    });

    it('falls back to `message` when no slackText is supplied', async () => {
        const { notify } = await import('./notifier.js');
        await notify({ ...base, eventType: 'interruption', alertType: 'interruption' });
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body.text).toBe('something happened');
    });

    it('uses a real hex colour, never the reference\'s invalid "#warning"', async () => {
        // Slack accepts a hex code or good|warning|danger. The reference passed "#warning"
        // and "#good", which are neither, so its colours were silently ignored.
        const { notify } = await import('./notifier.js');
        await notify({ ...base, eventType: 'interruption', alertType: 'interruption', severity: 'critical' });
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body.color).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('marks the row delivered on success', async () => {
        const { notify } = await import('./notifier.js');
        const res = await notify({ ...base, eventType: 'interruption', alertType: 'interruption' });
        expect(res.slackDelivered).toBe(true);
        expect(markEventNotified).toHaveBeenCalledWith(expect.objectContaining({ notified: true }));
    });
});

describe('notify — failures must never propagate', () => {
    it('does not throw when the relay returns 500', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
        const { notify } = await import('./notifier.js');

        // A throw here would make pg-boss retry a job whose ecs:UpdateService already
        // succeeded — bouncing production tasks a second time for a Slack outage.
        const res = await notify({ ...base, eventType: 'interruption', alertType: 'interruption' });
        expect(res.slackDelivered).toBe(false);
        expect(markEventNotified).toHaveBeenCalledWith(expect.objectContaining({ notified: false }));
    });

    it('does not throw when fetch itself rejects', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
        const { notify } = await import('./notifier.js');
        await expect(notify({ ...base, eventType: 'interruption', alertType: 'interruption' })).resolves.toMatchObject({
            slackDelivered: false,
        });
    });

    it('reports delivered:false when the tenant has no Slack configured', async () => {
        // The route answers 200 with delivered:false for this — a normal outcome, not an error.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                new Response(JSON.stringify({ success: true, data: { delivered: false, reason: 'not_configured' } }), {
                    status: 200,
                }),
            ),
        );
        const { notify } = await import('./notifier.js');
        const res = await notify({ ...base, eventType: 'interruption', alertType: 'interruption' });
        expect(res.slackDelivered).toBe(false);
        expect(markEventNotified).toHaveBeenCalledWith(
            expect.objectContaining({ notified: false, slackError: 'not_configured' }),
        );
    });

    it('is quiet and sends nothing when the relay is not configured', async () => {
        // Removed AFTER the beforeEach reset, so the import below snapshots it as absent.
        delete process.env.INTERNAL_API_KEY;
        const { notify } = await import('./notifier.js');
        const res = await notify({ ...base, eventType: 'interruption', alertType: 'interruption' });

        expect(fetch).not.toHaveBeenCalled();
        expect(res.slackDelivered).toBe(false);
        // The event row still exists — the timeline works with or without Slack.
        expect(writeEvent).toHaveBeenCalledTimes(1);
    });

    it('still attempts the alert when the event write fails', async () => {
        // Losing the row is bad; losing the row AND the page would be worse.
        writeEvent.mockRejectedValue(new Error('db down'));
        const { notify } = await import('./notifier.js');

        const res = await notify({ ...base, eventType: 'interruption', alertType: 'interruption' });
        expect(res.eventId).toBeNull();
        expect(fetch).toHaveBeenCalled();
    });
});

describe('notify — audit logging', () => {
    it('writes an audit entry only when one is requested', async () => {
        const { notify } = await import('./notifier.js');
        await notify({ ...base, eventType: 'interruption', alertType: 'interruption' });
        expect(writeAuditLog).not.toHaveBeenCalled();

        await notify({
            ...base,
            eventType: 'fallback_applied',
            alertType: 'remediation',
            audit: {
                eventType: 'spot_guard.fallback.applied',
                action: 'Switched ECS service to Fargate On-Demand',
                severity: 'high',
                details: 'details',
            },
        });
        expect(writeAuditLog).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'spot_guard.fallback.applied', severity: 'high' }),
        );
    });

    it('does not fail the notify when the audit write fails', async () => {
        writeAuditLog.mockRejectedValue(new Error('audit down'));
        const { notify } = await import('./notifier.js');
        await expect(
            notify({
                ...base,
                eventType: 'fallback_applied',
                audit: { eventType: 'x', action: 'y', severity: 'high', details: 'z' },
            }),
        ).resolves.toBeDefined();
    });
});
