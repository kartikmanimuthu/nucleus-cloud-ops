// web-ui/lib/spot-guard/notify.ts
//
// Slack delivery for Spot Guard alerts.
//
// Reuses the EXISTING per-tenant Slack integration config ('agent-ops-slack' in
// tenant_configs) rather than introducing a Spot-specific webhook. That is the whole point
// of doing this in Nucleus: the reference implementation hardcoded ONE Slack webhook URL,
// committed in plaintext in four separate files, shared across every account with no
// routing. Here each tenant's alerts go to that tenant's own workspace, and the secret is
// already stored where the platform keeps it.
//
// Reads TenantConfigService directly rather than constructing a SlackAdapter: the adapter's
// loadConfig is private and its send methods are all shaped around an AgentOpsRun, which a
// Spot alert is not.
import { TenantConfigService } from '@/lib/tenant-config-service';
import type { SlackIntegrationConfig } from '@/lib/agent-ops/types';

/** Per-tenant Spot Guard settings, including which channel alerts go to. */
interface SpotGuardTenantConfig {
    slackChannelId?: string;
    slackEnabled?: boolean;
    reportTimezone?: string;
}

export type NotifyResult =
    | { delivered: true }
    | { delivered: false; reason: 'not_configured' | 'disabled' | 'no_channel' | 'error'; error?: string };

const SLACK_POST_MESSAGE = 'https://slack.com/api/chat.postMessage';

/** Facts the workers relay so the message can be composed here rather than sentence-built there. */
export interface SpotAlertContext {
    eventType?: string;
    serviceName?: string;
    accountId?: string;
    region?: string;
    clusterName?: string;
    fromCapacity?: string | null;
    toCapacity?: string | null;
}

/**
 * One short headline per event type. Deliberately verb-first and under ~30 characters: the service
 * name follows it in bold, and the account/region/cluster go in a small context line underneath, so
 * repeating any of that here would just make the headline wrap.
 */
const HEADLINE: Record<string, { emoji: string; text: string }> = {
    interruption: { emoji: ':warning:', text: 'Spot task reclaimed' },
    placement_failure: { emoji: ':rotating_light:', text: 'Spot capacity unavailable' },
    fallback_applied: { emoji: ':shield:', text: 'Moved to On-Demand' },
    restore_attempted: { emoji: ':seedling:', text: 'Restoring to Spot' },
    restore_succeeded: { emoji: ':white_check_mark:', text: 'Back on Spot' },
    restore_failed: { emoji: ':x:', text: 'Restore failed' },
    spot_enabled: { emoji: ':zap:', text: 'Spot enabled' },
    spot_disabled: { emoji: ':no_entry_sign:', text: 'Spot disabled' },
    alb_predrain: { emoji: ':ocean:', text: 'Traffic drained' },
    capacity_transition: { emoji: ':left_right_arrow:', text: 'Capacity changed' },
};

const CAPACITY_WORD: Record<string, string> = { spot: 'Spot', on_demand: 'On-Demand' };

function headlineFor(ctx: SpotAlertContext): { emoji: string; text: string } {
    // A transition reads far better as a direction than as "Capacity changed": the whole point of
    // the alert is which way it went.
    if (ctx.eventType === 'capacity_transition' && ctx.fromCapacity && ctx.toCapacity) {
        const from = CAPACITY_WORD[ctx.fromCapacity] ?? ctx.fromCapacity;
        const to = CAPACITY_WORD[ctx.toCapacity] ?? ctx.toCapacity;
        return {
            emoji: ctx.toCapacity === 'spot' ? ':white_check_mark:' : ':shield:',
            text: `${from} → ${to}`,
        };
    }
    return HEADLINE[ctx.eventType ?? ''] ?? { emoji: ':information_source:', text: 'Spot Guard' };
}

/**
 * Build the Slack payload.
 *
 * The previous version sent BOTH a top-level `text` and an attachment containing the same string,
 * so Slack rendered every alert twice — once plain, once inside the coloured bar. The text now
 * travels only as the attachment's `fallback`, which Slack uses for notifications and previews and
 * never renders inline.
 *
 * 'digest' keeps the daily report as-is: it is a formatted multi-line block and squeezing it into a
 * headline shape would destroy it.
 */
function buildMessage(input: {
    channel: string;
    text: string;
    color?: string;
    layout?: 'alert' | 'digest';
    context?: SpotAlertContext;
}): Record<string, unknown> {
    const { channel, text, color, layout = 'alert', context } = input;

    if (layout === 'digest' || !context?.serviceName) {
        return {
            channel,
            ...(color
                ? { attachments: [{ color, fallback: text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }] }
                : { text }),
        };
    }

    const { emoji, text: headline } = headlineFor(context);
    // region · account · cluster, in Slack's small grey context style. Omit any part we were not
    // given rather than printing "n/a".
    const meta = [context.region, context.accountId ? `\`${context.accountId}\`` : null, context.clusterName]
        .filter(Boolean)
        .join('  ·  ');

    return {
        channel,
        attachments: [
            {
                color: color ?? '#6b7280',
                // Notification text only — never shown in the channel, so it can stay descriptive.
                fallback: text,
                blocks: [
                    {
                        type: 'section',
                        text: { type: 'mrkdwn', text: `${emoji}  ${headline} — *${context.serviceName}*` },
                    },
                    ...(meta ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: meta }] }] : []),
                ],
            },
        ],
    };
}

/**
 * Post a Spot Guard alert to the tenant's Slack.
 *
 * NEVER THROWS. A Slack outage, a missing bot token or a revoked channel must not fail the
 * caller — the caller is a remediation job, and failing it would make pg-boss retry an
 * ecs:UpdateService that already succeeded. Every failure mode is returned as data so the
 * event row can record why delivery did not happen.
 */
export async function sendSpotGuardSlackAlert(input: {
    tenantId: string;
    text: string;
    /** Slack attachment colour: a hex code or one of good|warning|danger. */
    color?: string;
    /** Overrides the tenant's default channel. */
    channelId?: string;
    /** 'digest' preserves the daily report's own formatting; 'alert' composes the compact shape. */
    layout?: 'alert' | 'digest';
    /** Facts used to compose the compact shape. Without a serviceName it falls back to plain text. */
    context?: SpotAlertContext;
}): Promise<NotifyResult> {
    try {
        const [slack, spotConfig] = await Promise.all([
            TenantConfigService.getConfig<SlackIntegrationConfig>('agent-ops-slack', input.tenantId).catch(() => null),
            TenantConfigService.getConfig<SpotGuardTenantConfig>('spot-guard', input.tenantId).catch(() => null),
        ]);

        if (!slack?.botToken) return { delivered: false, reason: 'not_configured' };
        // Honour BOTH switches: the workspace-level Slack integration, and a Spot-specific
        // opt-out so a tenant can keep Slack for Agent Ops while silencing Spot noise.
        if (slack.enabled === false) return { delivered: false, reason: 'disabled' };
        if (spotConfig?.slackEnabled === false) return { delivered: false, reason: 'disabled' };

        const channel = input.channelId ?? spotConfig?.slackChannelId;
        if (!channel) return { delivered: false, reason: 'no_channel' };

        const res = await fetch(SLACK_POST_MESSAGE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${slack.botToken}` },
            // Slack accepts a hex code or the keywords good|warning|danger for `color`. The
            // reference passed "#warning" and "#good", which are NEITHER, so its attachment
            // colours were silently ignored for the feature's whole life.
            body: JSON.stringify(
                buildMessage({
                    channel,
                    text: input.text,
                    color: input.color,
                    layout: input.layout,
                    context: input.context,
                }),
            ),
        });

        // Slack returns HTTP 200 with { ok: false, error } for application-level failures
        // (invalid_auth, channel_not_found, ...), so checking res.ok alone would report
        // success for a message nobody received.
        const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !body?.ok) {
            return { delivered: false, reason: 'error', error: body?.error ?? `HTTP ${res.status}` };
        }
        return { delivered: true };
    } catch (err) {
        return { delivered: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
    }
}
