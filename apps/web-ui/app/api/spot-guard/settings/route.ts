/**
 * GET  /api/spot-guard/settings — the tenant's Spot Guard settings
 * PUT  /api/spot-guard/settings — validate and save them
 *
 * These live in tenant_configs under the 'spot-guard' key, which until now nothing could write.
 * The three fields it holds were readable by code and settable only by hand in the database:
 *
 *   slackChannelId   where alerts go            read by lib/spot-guard/notify.ts
 *   slackEnabled     mute Spot alerts only      read by lib/spot-guard/notify.ts
 *   reportTimezone   the daily report's day     read by the workers' handle-report-scan.ts
 *
 * The practical consequence was that a tenant could connect Slack at Connectors -> Slack and still
 * get no Spot alerts: with no channel, notify() records the event and returns reason 'no_channel'.
 *
 * The bot token deliberately stays where it is (the 'agent-ops-slack' key, owned by
 * /api/agent-ops/settings/slack). One Slack workspace connection, many features using it.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';

const CONFIG_KEY = 'spot-guard';

/** Everything stored under the key. Unknown fields are preserved on write — see PUT. */
interface SpotGuardSettings {
    slackChannelId?: string;
    slackEnabled?: boolean;
    reportTimezone?: string;
}

/**
 * A Slack channel id (C…/G…/D…) or a #name.
 *
 * chat.postMessage accepts either, and notify() passes the value straight through, so both are
 * allowed. The check exists to catch the likely mistake — pasting a channel's display name with no
 * '#', which Slack rejects at send time with channel_not_found, i.e. long after the person who
 * typed it has moved on.
 *
 * TWO regexes, not one alternation with /i. Merged with a global /i flag the check was broken:
 * `[CGD]` matched a lowercase `g`, so the bare name "general" parsed as an ID (g + 6 chars) and
 * passed — exactly the input this is supposed to reject. Slack ids are uppercase; names are not.
 */
const CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;
const CHANNEL_NAME = /^#[a-z0-9][a-z0-9._-]{0,79}$/i;

function isValidChannel(v: string): boolean {
    return CHANNEL_ID.test(v) || CHANNEL_NAME.test(v);
}

/**
 * IANA zone, checked by asking Intl to use it.
 *
 * Worth rejecting here rather than at report time: the workers' reportTimezoneFor() catches a bad
 * zone and silently falls back to UTC, so an invalid value would look saved and simply produce
 * reports for the wrong day forever.
 *
 * ICU also accepts legacy aliases — 'IST' resolves to GMT+05:30 and 'EST' to GMT-05:00 — and those
 * are allowed rather than blocked. The workers format through the same Intl implementation, so they
 * agree with us and no fallback happens; inventing a stricter rule here would reject values that
 * demonstrably work. The form's placeholder steers toward canonical names instead.
 */
function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

const SettingsSchema = z.object({
    // '' clears the channel — the only way to go back to "no alerts" without deleting the row.
    slackChannelId: z
        .string()
        .trim()
        .refine((v) => v === '' || isValidChannel(v), {
            message: 'Enter a Slack channel ID (e.g. C0123456789) or a #channel-name',
        })
        .optional(),
    slackEnabled: z.boolean().optional(),
    reportTimezone: z
        .string()
        .trim()
        .refine((v) => v === '' || isValidTimezone(v), { message: 'Not a valid IANA timezone (e.g. Asia/Kolkata)' })
        .optional(),
});

export async function GET() {
    try {
        const authError = await authorize('read', 'SpotGuard');
        if (authError) return authError;

        const tenantId = await getSessionTenantId();
        const config = await TenantConfigService.getConfig<SpotGuardSettings>(CONFIG_KEY, tenantId);

        return NextResponse.json({
            success: true,
            data: {
                slackChannelId: config?.slackChannelId ?? '',
                // Absent means on: alerts are opt-OUT, matching notify(), which only suppresses on
                // an explicit `slackEnabled === false`.
                slackEnabled: config?.slackEnabled ?? true,
                reportTimezone: config?.reportTimezone ?? '',
            },
        });
    } catch (error) {
        console.error('API - Error reading spot-guard settings:', error);
        return NextResponse.json({ success: false, error: 'Failed to read settings' }, { status: 500 });
    }
}

export async function PUT(request: Request) {
    try {
        const authError = await authorize('update', 'SpotGuard');
        if (authError) return authError;

        const tenantId = await getSessionTenantId();
        const parsed = SettingsSchema.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.issues.map((i) => i.message).join('; ') },
                { status: 400 },
            );
        }

        // MERGE, never replace. saveConfig overwrites the whole json blob, and this one key is
        // shared by two apps: the Slack fields are read by web-ui, reportTimezone by the workers.
        // A blind write from a form that happens to omit one of them would silently reset it.
        const existing = (await TenantConfigService.getConfig<SpotGuardSettings>(CONFIG_KEY, tenantId)) ?? {};
        const next: SpotGuardSettings = { ...existing, ...parsed.data };

        const session = await getAuthSession();
        const actor = session?.user?.email ?? 'api-user';
        await TenantConfigService.saveConfig<SpotGuardSettings>(CONFIG_KEY, next, tenantId, actor);

        await AuditService.logUserAction({
            tenantId,
            action: 'update',
            resourceType: 'SpotGuardSettings',
            resourceId: CONFIG_KEY,
            resourceName: 'Spot Guard settings',
            user: actor,
            userType: 'user',
            status: 'success',
            // The channel is not a secret, but it is a destination — worth an audit trail, since
            // changing it silently redirects every future alert.
            details: `Spot Guard settings updated (channel: ${next.slackChannelId || 'none'}, alerts: ${
                next.slackEnabled === false ? 'muted' : 'on'
            }, report timezone: ${next.reportTimezone || 'default'})`,
            eventType: 'spotguard.settings.update',
            metadata: {
                slackChannelId: next.slackChannelId ?? '',
                slackEnabled: next.slackEnabled ?? true,
                reportTimezone: next.reportTimezone ?? '',
                apiRoute: 'PUT /api/spot-guard/settings',
            },
        }).catch((err) => {
            // Never fail the save because the audit write did.
            console.error('API - spot-guard settings audit log failed:', err);
        });

        return NextResponse.json({ success: true, data: next });
    } catch (error) {
        console.error('API - Error saving spot-guard settings:', error);
        return NextResponse.json({ success: false, error: 'Failed to save settings' }, { status: 500 });
    }
}
