"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GatedButton } from "@/components/rbac/gated";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useSaveSpotGuardSettings, useSpotGuardSettings } from "@/lib/queries/spot-guard";

/**
 * Mirrors the server's checks in app/api/spot-guard/settings/route.ts so the message appears as you
 * type rather than after a round trip. The server still validates — this is not the gate.
 */
// Two regexes, matching the server: a single /i alternation let `[CGD]` match a
// lowercase `g`, so the bare name "general" passed as an ID.
const CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;
const CHANNEL_NAME = /^#[a-z0-9][a-z0-9._-]{0,79}$/i;
const isValidChannel = (v: string) => CHANNEL_ID.test(v) || CHANNEL_NAME.test(v);

const schema = z.object({
    slackChannelId: z
        .string()
        .trim()
        .refine((v) => v === "" || isValidChannel(v), {
            message: "Use a channel ID (e.g. C0123456789) or a #channel-name",
        }),
    slackEnabled: z.boolean(),
    reportTimezone: z
        .string()
        .trim()
        .refine(
            (v) => {
                if (v === "") return true;
                try {
                    new Intl.DateTimeFormat("en-US", { timeZone: v });
                    return true;
                } catch {
                    return false;
                }
            },
            { message: "Not a valid IANA timezone (e.g. Asia/Kolkata)" },
        ),
});

type FormValues = z.infer<typeof schema>;

export function SpotGuardSettingsForm() {
    const { data, isLoading } = useSpotGuardSettings();
    const save = useSaveSpotGuardSettings();

    /**
     * No zodResolver, deliberately.
     *
     * This repo pins @hookform/resolvers 3.10 with zod 4.4. Resolvers 3.x reads `e.errors` off the
     * ZodError, which zod 4 renamed to `e.issues`, so the resolver fails to recognise the failure
     * and RETHROWS it: an uncaught ZodError in the console, formState.errors never populated, and a
     * Save button that silently does nothing. Verified in a browser before writing this.
     *
     * Validating in the submit handler with safeParse + setError gives the same messages against the
     * same schema without depending on that broken bridge. The server validates independently.
     */
    const form = useForm<FormValues>({
        defaultValues: { slackChannelId: "", slackEnabled: true, reportTimezone: "" },
    });

    // Hydrate once the query resolves. reset() rather than setValue() so the form's dirty state
    // starts clean against the saved values, which is what makes the Save button meaningful.
    useEffect(() => {
        if (data) form.reset(data);
    }, [data, form]);

    const onSubmit = (values: FormValues) => {
        form.clearErrors();
        const parsed = schema.safeParse(values);
        if (!parsed.success) {
            // zod 4: `.issues`, not `.errors` — the same rename that breaks the resolver above.
            for (const issue of parsed.error.issues) {
                const field = issue.path[0];
                if (typeof field === "string") {
                    form.setError(field as keyof FormValues, { type: "manual", message: issue.message });
                }
            }
            return;
        }

        save.mutate(parsed.data, {
            onSuccess: (saved) => {
                form.reset(saved);
                toast.success("Spot Guard settings saved");
            },
            onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save settings"),
        });
    };

    if (isLoading) {
        return (
            <div className="space-y-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    const channelSet = Boolean(form.watch("slackChannelId")?.trim());

    return (
        <div className="space-y-6">
            <Link
                href="/app/cost-optimization/spot-guard"
                className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="mr-1 h-4 w-4" />
                Back to Spot Guard
            </Link>

            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <Card>
                    <CardHeader>
                        <CardTitle>Slack alerts</CardTitle>
                        <CardDescription>
                            Where Spot Guard posts interruptions, fallbacks, restores and the daily report. It uses the
                            Slack workspace you connect under Connectors, so there is no second token to manage here.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="space-y-2">
                            <Label htmlFor="slackChannelId">Channel</Label>
                            <Input
                                id="slackChannelId"
                                placeholder="C0123456789 or #cloud-ops"
                                aria-label="Slack channel"
                                {...form.register("slackChannelId")}
                            />
                            {form.formState.errors.slackChannelId ? (
                                <p className="text-xs text-red-600">{form.formState.errors.slackChannelId.message}</p>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    {channelSet
                                        ? "Invite the Nucleus bot to this channel, or Slack rejects the post with channel_not_found."
                                        : "No channel set — alerts are recorded on the timeline but not posted to Slack."}
                                </p>
                            )}
                        </div>

                        <div className="flex items-start justify-between gap-4">
                            <div className="space-y-1">
                                <Label htmlFor="slackEnabled">Post Spot Guard alerts</Label>
                                <p className="text-xs text-muted-foreground">
                                    Turn off to silence Spot Guard specifically while leaving Slack working for
                                    everything else. Events are still recorded either way.
                                </p>
                            </div>
                            <Switch
                                id="slackEnabled"
                                aria-label="Post Spot Guard alerts"
                                checked={form.watch("slackEnabled")}
                                onCheckedChange={(v) => form.setValue("slackEnabled", v, { shouldDirty: true })}
                            />
                        </div>

                        <p className="text-xs text-muted-foreground">
                            Not connected to Slack yet?{" "}
                            <Link
                                href="/app/channels/slack-settings"
                                className="inline-flex items-center underline hover:text-foreground"
                            >
                                Connect the workspace
                                <ExternalLink className="ml-0.5 h-3 w-3" />
                            </Link>
                        </p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Daily report</CardTitle>
                        <CardDescription>
                            Which calendar day the report covers. Left empty it uses the stack default (UTC), so a
                            report labelled &ldquo;yesterday&rdquo; runs midnight to midnight UTC rather than local time.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <Label htmlFor="reportTimezone">Report timezone</Label>
                        <Input
                            id="reportTimezone"
                            placeholder="Asia/Kolkata"
                            aria-label="Report timezone"
                            {...form.register("reportTimezone")}
                        />
                        {form.formState.errors.reportTimezone ? (
                            <p className="text-xs text-red-600">{form.formState.errors.reportTimezone.message}</p>
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                An IANA name. Setting Asia/Kolkata moves the day boundary to 18:30 UTC, so Spot hours
                                land on the day they were actually used.
                            </p>
                        )}
                    </CardContent>
                </Card>

                <div className="flex items-center gap-3">
                    {/*
                     * Gated on the same (action, subject) the PUT enforces —
                     * app/api/spot-guard/settings/route.ts's authorize('update',
                     * 'SpotGuard'). Ungated, a role without SpotGuard:update got a
                     * live button and learned it was denied only from the 403.
                     * SpotGuard sits under the Schedules module (see
                     * SUBJECT_TO_MODULE) because it restarts live ECS tasks.
                     */}
                    <GatedButton
                        action="update"
                        subject="SpotGuard"
                        type="submit"
                        disabled={save.isPending || !form.formState.isDirty}
                    >
                        {save.isPending && <Spinner className="mr-2 h-4 w-4" />}
                        Save settings
                    </GatedButton>
                    {!form.formState.isDirty && !save.isPending && (
                        <span className="text-xs text-muted-foreground">No unsaved changes</span>
                    )}
                </div>
            </form>
        </div>
    );
}
