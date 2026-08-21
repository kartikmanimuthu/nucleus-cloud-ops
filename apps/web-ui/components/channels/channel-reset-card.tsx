'use client';

/**
 * ChannelResetCard
 *
 * Shared "danger zone" footer for every channel settings form. Deletes the
 * channel's stored configuration, returning it to the unconfigured state.
 *
 * Renders nothing when the channel is not configured — there is nothing to
 * reset, and an empty setup page should stay clean.
 */
import { useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { GatedButton } from '@/components/rbac/gated';
import { Card, CardContent } from '@/components/ui/card';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useResetChannelSettings } from '@/lib/queries/channel-settings';

interface ChannelResetCardProps {
    /** Channel slug as used in /api/agent-ops/settings/<channel> */
    channel: string;
    /** Display name, e.g. "Slack" */
    name: string;
    /** What the reset destroys, e.g. "signing secret, bot token and workspace link" */
    clears: string;
    /** Whether the channel currently has a stored configuration */
    configured: boolean;
    /**
     * Clear the parent form's local state after a successful reset. The forms seed
     * their fields from props at mount, so invalidating the query alone would leave
     * the emptied channel still rendering as configured.
     */
    onReset: () => void;
}

export function ChannelResetCard({ channel, name, clears, configured, onReset }: ChannelResetCardProps) {
    const [open, setOpen] = useState(false);
    const resetMutation = useResetChannelSettings(channel);

    if (!configured) return null;

    const handleReset = async () => {
        try {
            await resetMutation.mutateAsync();
            setOpen(false);
            onReset();
            toast.success(`${name} configuration reset`);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : '';
            toast.error(message || `Failed to reset ${name} configuration`);
        }
    };

    return (
        <>
            <Card className="border-destructive/30">
                <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                        <p className="text-sm font-medium">Reset configuration</p>
                        <p className="text-sm text-muted-foreground">
                            Removes the stored {clears} for {name}.
                        </p>
                    </div>
                    {/*
                      * Reset deletes the stored credentials, so it asks for `delete`,
                      * matching the route's DELETE gate. Already a state-controlled
                      * dialog rather than AlertDialogTrigger, so GatedButton's disabled
                      * state survives — see the note in components/rbac/gated.tsx.
                      */}
                    <GatedButton
                        action="delete"
                        subject="Channel"
                        variant="outline"
                        size="sm"
                        className="gap-2 shrink-0 text-destructive hover:text-destructive"
                        onClick={() => setOpen(true)}
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Reset
                    </GatedButton>
                </CardContent>
            </Card>

            <AlertDialog open={open} onOpenChange={setOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Reset {name} configuration?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This deletes the stored {clears}. You&apos;ll need to enter them again to
                            use {name}. This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={resetMutation.isPending}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => {
                                // Keep the dialog open while the request is in flight; it is
                                // closed explicitly on success so a failure stays visible.
                                e.preventDefault();
                                handleReset();
                            }}
                            disabled={resetMutation.isPending}
                            className="gap-2 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            {resetMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            Reset
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
