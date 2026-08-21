import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression cover for the seam between the account form's Spot Automation choice and the
 * generated CloudFormation template.
 *
 * The generator itself was always correct and well covered (cf-template-generator.test.ts).
 * What was untested was `spotGuardOptions` in this route, which resolves the hub bus ARN
 * from the environment and — deliberately — forces the toggle off when it cannot find one.
 * SPOT_GUARD_BUS_ARN was never plumbed into the web-ui container, so on the deployed sbx
 * console every generated template came out with HubEventBusArn defaulted to the
 * `not-configured` placeholder AND EnableSpotAutomation pinned to "false", no matter what
 * the user picked. Two symptoms, one missing environment variable.
 *
 * These tests pin both halves: that a configured bus reaches the template, and that an
 * unconfigured one still fails closed rather than emitting a template aimed at a bus that
 * does not exist.
 */

const BUS = 'arn:aws:events:ap-south-1:970547372609:event-bus/stx-nucleus-ops-sbx-spot-guard';
const PLACEHOLDER = 'arn:aws:events:ap-south-1:000000000000:event-bus/not-configured';

const { mockEnv } = vi.hoisted(() => ({
    mockEnv: {
        SPOT_GUARD_BUS_ARN: undefined as string | undefined,
        NEXT_PUBLIC_HUB_ACCOUNT_ID: '970547372609' as string | undefined,
        HUB_ACCOUNT_ID: undefined as string | undefined,
    },
}));

vi.mock('@/env', () => ({ env: mockEnv }));

import { GET, POST } from './route';

/** The route only reads searchParams, so a bare Request is enough. */
function get(params: Record<string, string>) {
    const qs = new URLSearchParams(params).toString();
    return GET(new Request(`http://localhost/api/accounts/template?${qs}`));
}

beforeEach(() => {
    mockEnv.SPOT_GUARD_BUS_ARN = BUS;
    vi.restoreAllMocks();
});

describe('GET /api/accounts/template — Spot Guard parameters', () => {
    it('defaults HubEventBusArn to the real hub bus, not the placeholder', async () => {
        const body = await (await get({ targetAccountId: '123412341234' })).json();

        expect(body.template.Parameters.HubEventBusArn.Default).toBe(BUS);
        expect(body.template.Parameters.HubEventBusArn.Default).not.toBe(PLACEHOLDER);
        expect(body.templateYaml).toContain(BUS);
    });

    it('emits EnableSpotAutomation Default "true" when the user opted in', async () => {
        const body = await (await get({ targetAccountId: '123412341234', enableSpotAutomation: 'true' })).json();

        const param = body.template.Parameters.EnableSpotAutomation;
        expect(param.Default).toBe('true');
        // The dropdown itself must survive — Type String + AllowedValues is what makes the
        // CloudFormation console render a picker (there is no Type: Boolean).
        expect(param.Type).toBe('String');
        expect(param.AllowedValues).toEqual(['true', 'false']);
        expect(body.spotAutomationEnabled).toBe(true);
    });

    it('emits EnableSpotAutomation Default "false" when the user opted out', async () => {
        const body = await (await get({ targetAccountId: '123412341234', enableSpotAutomation: 'false' })).json();

        expect(body.template.Parameters.EnableSpotAutomation.Default).toBe('false');
        expect(body.spotAutomationEnabled).toBe(false);
        // Opting out must NOT degrade the bus ARN — the parameter is still there, correct,
        // ready for the operator to flip in the CloudFormation console.
        expect(body.template.Parameters.HubEventBusArn.Default).toBe(BUS);
    });

    it('YAML and JSON agree on both defaults', async () => {
        const body = await (await get({ targetAccountId: '123412341234', enableSpotAutomation: 'true' })).json();

        expect(body.templateYaml).toContain("Default: 'true'");
        expect(body.templateYaml).toContain(`Default: '${BUS}'`);
    });

    it('treats a missing enableSpotAutomation param as opted out', async () => {
        const body = await (await get({ targetAccountId: '123412341234' })).json();
        expect(body.template.Parameters.EnableSpotAutomation.Default).toBe('false');
    });

    describe('when SPOT_GUARD_BUS_ARN is unset (stack has not opted in)', () => {
        beforeEach(() => {
            mockEnv.SPOT_GUARD_BUS_ARN = undefined;
        });

        it('fails closed: forces the toggle off even though the user asked for it', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const body = await (await get({ targetAccountId: '1', enableSpotAutomation: 'true' })).json();

            // Handing a customer a template that forwards events to a bus which does not
            // exist would fail at stack-create time in THEIR account, so off is correct.
            expect(body.template.Parameters.EnableSpotAutomation.Default).toBe('false');
            expect(body.spotAutomationEnabled).toBe(false);
            expect(body.template.Parameters.HubEventBusArn.Default).toBe(PLACEHOLDER);
            // ...but it must be loud, because this is indistinguishable from a UI bug.
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('SPOT_GUARD_BUS_ARN'));
        });
    });
});

describe('POST /api/accounts/template — same contract as GET', () => {
    it('honours enableSpotAutomation: true from the JSON body', async () => {
        const res = await POST(
            new Request('http://localhost/api/accounts/template', {
                method: 'POST',
                body: JSON.stringify({ accountId: '123412341234', enableSpotAutomation: true }),
            }),
        );
        const body = await res.json();

        expect(body.success).toBe(true);
        expect(body.template.Parameters.EnableSpotAutomation.Default).toBe('true');
        expect(body.template.Parameters.HubEventBusArn.Default).toBe(BUS);
    });

    it('only accepts a real boolean true, not the string "true"', async () => {
        // The form sends a boolean here; a string would mean the caller is passing the raw
        // Select value through, which the === true comparison intentionally rejects.
        const res = await POST(
            new Request('http://localhost/api/accounts/template', {
                method: 'POST',
                body: JSON.stringify({ accountId: '123412341234', enableSpotAutomation: 'true' }),
            }),
        );
        const body = await res.json();
        expect(body.template.Parameters.EnableSpotAutomation.Default).toBe('false');
    });
});
