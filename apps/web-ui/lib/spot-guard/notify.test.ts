// web-ui/lib/spot-guard/notify.test.ts
//
// Slack delivery must never throw and must never report success for a message nobody
// received — Slack answers HTTP 200 with { ok: false } for application-level failures, so
// checking res.ok alone would silently swallow invalid_auth and channel_not_found.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getConfig } = vi.hoisted(() => ({ getConfig: vi.fn() }));
vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig } }));

const slackOk = { signingSecret: 's', botToken: 'xoxb-test', enabled: true };
const spotCfg = { slackChannelId: 'C123' };

/** getConfig is called with the config key, so route each key to its own fixture. */
function configureTenant(slack: unknown, spot: unknown) {
    getConfig.mockImplementation(async (key: string) => {
        if (key === 'agent-ops-slack') return slack;
        if (key === 'spot-guard') return spot;
        return null;
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    configureTenant(slackOk, spotCfg);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
});

afterEach(() => vi.unstubAllGlobals());

describe('sendSpotGuardSlackAlert', () => {
    it('posts to the tenant channel with the tenant bot token', async () => {
        const { sendSpotGuardSlackAlert } = await import('./notify');
        const res = await sendSpotGuardSlackAlert({ tenantId: 't1', text: 'hello' });

        expect(res).toEqual({ delivered: true });
        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(url).toBe('https://slack.com/api/chat.postMessage');
        expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test');
        expect(JSON.parse(init!.body as string).channel).toBe('C123');
    });

    it('treats { ok: false } on an HTTP 200 as a FAILURE', async () => {
        // The subtle one. Slack returns 200 with ok:false for invalid_auth,
        // channel_not_found, not_in_channel... Reporting success here would mean the event row
        // claims Slack was notified when it was not.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 })),
        );
        const { sendSpotGuardSlackAlert } = await import('./notify');
        expect(await sendSpotGuardSlackAlert({ tenantId: 't1', text: 'x' })).toEqual({
            delivered: false,
            reason: 'error',
            error: 'channel_not_found',
        });
    });

    it('reports not_configured when the tenant has no bot token', async () => {
        configureTenant({ signingSecret: 's', enabled: true }, spotCfg);
        const { sendSpotGuardSlackAlert } = await import('./notify');
        expect(await sendSpotGuardSlackAlert({ tenantId: 't1', text: 'x' })).toEqual({
            delivered: false,
            reason: 'not_configured',
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('honours the workspace-level Slack disable', async () => {
        configureTenant({ ...slackOk, enabled: false }, spotCfg);
        const { sendSpotGuardSlackAlert } = await import('./notify');
        expect(await sendSpotGuardSlackAlert({ tenantId: 't1', text: 'x' })).toMatchObject({ reason: 'disabled' });
    });

    it('honours a Spot-specific opt-out while Slack stays on for other features', async () => {
        // A tenant may want Agent Ops notifications but not Spot noise.
        configureTenant(slackOk, { ...spotCfg, slackEnabled: false });
        const { sendSpotGuardSlackAlert } = await import('./notify');
        expect(await sendSpotGuardSlackAlert({ tenantId: 't1', text: 'x' })).toMatchObject({ reason: 'disabled' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('reports no_channel when no channel is configured or supplied', async () => {
        configureTenant(slackOk, {});
        const { sendSpotGuardSlackAlert } = await import('./notify');
        expect(await sendSpotGuardSlackAlert({ tenantId: 't1', text: 'x' })).toMatchObject({ reason: 'no_channel' });
    });

    it('lets an explicit channelId override the tenant default', async () => {
        const { sendSpotGuardSlackAlert } = await import('./notify');
        await sendSpotGuardSlackAlert({ tenantId: 't1', text: 'x', channelId: 'C999' });
        expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).channel).toBe('C999');
    });

    it('never throws when fetch rejects', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
        const { sendSpotGuardSlackAlert } = await import('./notify');
        await expect(sendSpotGuardSlackAlert({ tenantId: 't1', text: 'x' })).resolves.toMatchObject({
            delivered: false,
            reason: 'error',
        });
    });

    it('never throws when the config lookup rejects', async () => {
        getConfig.mockRejectedValue(new Error('db down'));
        const { sendSpotGuardSlackAlert } = await import('./notify');
        // The .catch(() => null) on each lookup degrades to not_configured rather than
        // propagating — a config outage must not fail a remediation job.
        await expect(sendSpotGuardSlackAlert({ tenantId: 't1', text: 'x' })).resolves.toMatchObject({
            delivered: false,
        });
    });

    it('attaches a colour only when one is supplied', async () => {
        const { sendSpotGuardSlackAlert } = await import('./notify');
        await sendSpotGuardSlackAlert({ tenantId: 't1', text: 'x' });
        expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).attachments).toBeUndefined();

        vi.mocked(fetch).mockClear();
        await sendSpotGuardSlackAlert({ tenantId: 't1', text: 'x', color: '#ff9900' });
        expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).attachments[0].color).toBe('#ff9900');
    });
});

/**
 * The message used to arrive DUPLICATED in Slack: the payload carried both a top-level `text` and an
 * attachment containing the same string, and Slack renders both. It also read as a full sentence
 * with the account and region in parentheses, which is a lot of words for "this service moved".
 *
 * The compact shape is a headline plus a small grey context line, composed here from facts the
 * workers relay, so every alert type comes out the same.
 */
describe('the compact alert layout', () => {
    const ctx = {
        eventType: 'fallback_applied',
        serviceName: 'stx-kyc-ekyc-admin-api',
        accountId: '688849551607',
        region: 'ap-south-1',
        clusterName: 'stx-kyc-ekyc-ecs-fargate',
    };

    const send = async (over: Record<string, unknown> = {}) => {
        const { sendSpotGuardSlackAlert } = await import('./notify');
        await sendSpotGuardSlackAlert({ tenantId: 't1', text: 'a long fallback sentence', color: '#ff9900', context: ctx, ...over });
        return JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    };

    it('sends NO top-level text, so Slack cannot render the message twice', async () => {
        const body = await send();

        expect(body.text).toBeUndefined();
        expect(body.attachments).toHaveLength(1);
    });

    it('keeps the sentence as the notification fallback rather than discarding it', async () => {
        // fallback drives the push/preview text and is never shown in the channel.
        const body = await send();
        expect(body.attachments[0].fallback).toBe('a long fallback sentence');
    });

    it('leads with a short headline and the service name', async () => {
        const body = await send();

        const section = body.attachments[0].blocks[0];
        expect(section.type).toBe('section');
        expect(section.text.text).toBe(':shield:  Moved to On-Demand — *stx-kyc-ekyc-admin-api*');
    });

    it('puts region, account and cluster in a small context line', async () => {
        const body = await send();

        const context = body.attachments[0].blocks[1];
        expect(context.type).toBe('context');
        expect(context.elements[0].text).toBe('ap-south-1  ·  `688849551607`  ·  stx-kyc-ekyc-ecs-fargate');
    });

    it('renders a capacity transition as a direction, not as "changed"', async () => {
        const body = await send({
            context: { ...ctx, eventType: 'capacity_transition', fromCapacity: 'spot', toCapacity: 'on_demand' },
        });

        expect(body.attachments[0].blocks[0].text.text).toContain('Spot → On-Demand');
    });

    it('uses a tick for the recovery direction', async () => {
        const body = await send({
            context: { ...ctx, eventType: 'capacity_transition', fromCapacity: 'on_demand', toCapacity: 'spot' },
        });

        const headline = body.attachments[0].blocks[0].text.text;
        expect(headline).toContain('On-Demand → Spot');
        expect(headline.startsWith(':white_check_mark:')).toBe(true);
    });

    it('falls back to a generic headline for an event type it does not know', async () => {
        const body = await send({ context: { ...ctx, eventType: 'something_new' } });
        expect(body.attachments[0].blocks[0].text.text).toContain('Spot Guard');
    });

    it('omits missing metadata instead of printing placeholders', async () => {
        const body = await send({ context: { eventType: 'interruption', serviceName: 'api', region: 'ap-south-1' } });

        expect(body.attachments[0].blocks[1].elements[0].text).toBe('ap-south-1');
    });

    it('leaves the daily digest formatting alone', async () => {
        // The report is a pre-built multi-line block; the headline shape would destroy it.
        const digest = ':date: *report*\n*Total:* 10 hrs\n---\nservice a';
        const body = await send({ layout: 'digest', text: digest });

        expect(body.text).toBeUndefined();
        expect(body.attachments[0].blocks).toHaveLength(1);
        expect(body.attachments[0].blocks[0].text.text).toBe(digest);
        expect(body.attachments[0].fallback).toBe(digest);
    });

    it('still posts a plain message when the workers send no context', async () => {
        // Backwards compatible: an older workers image relaying only text keeps working.
        const body = await send({ context: undefined });

        expect(body.attachments[0].blocks[0].text.text).toBe('a long fallback sentence');
    });
});
