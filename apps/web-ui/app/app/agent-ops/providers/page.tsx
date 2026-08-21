"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
    Plus,
    RefreshCw,
    Star,
    Pencil,
    Trash2,
    CheckCircle2,
    Server,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Spinner, SpinnerOverlay } from "@/components/ui/spinner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
    useProviders,
    useDeleteProvider,
    useToggleProvider,
    useSetDefaultProvider,
    useRefreshModels,
    type Provider,
} from "@/lib/queries/providers";
import { PROVIDER_TYPE_META } from "@/components/settings/provider-wizard";
import { GatedButton } from "@/components/rbac/gated";
import { useCan, useDenialReason } from "@/hooks/use-can";
import type { ProviderType } from "@/lib/queries/providers";

function providerLabel(provider: string): string {
    return PROVIDER_TYPE_META[provider as ProviderType]?.label ?? provider;
}

export default function ProvidersPage() {
    /**
     * Every write on this page — create, edit, toggle, set-default, refresh
     * models, delete — routes through `update Provider` (see the authz
     * declarations on /api/settings/providers/*). Read is `read Provider`.
     *
     * Provider is the "LLM Provider" row under AI Ops, seeded with navPath
     * /app/agent-ops/providers since 20260812100000. This page used to gate on
     * the bare AIOps module instead — a catch-all the role editor hides — so the
     * Provider row it already rendered controlled nothing, and the only real
     * control was the whole AI Ops module checkbox.
     *
     * This page previously sat under app/app/settings/, whose layout called
     * requireAuth('read', 'Account') — a third, unrelated permission. Moving it
     * under agent-ops removed that guard, so the page now owns its own gating.
     */
    const canWrite = useCan("update", "Provider");
    const writeDenial = useDenialReason("update", "Provider");

    const providersQuery = useProviders();
    const deleteProvider = useDeleteProvider();
    const toggleProvider = useToggleProvider();
    const setDefaultProvider = useSetDefaultProvider();
    const refreshModels = useRefreshModels();

    const providers = providersQuery.data ?? [];
    const [refreshingId, setRefreshingId] = useState<string | null>(null);
    const [pendingDelete, setPendingDelete] = useState<Provider | null>(null);

    const error =
        providersQuery.error instanceof Error ? providersQuery.error.message : null;

    const handleRefresh = async (id: string) => {
        setRefreshingId(id);
        try {
            await refreshModels.mutateAsync(id);
            toast.success("Models refreshed.");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to refresh models.");
        } finally {
            setRefreshingId(null);
        }
    };

    const handleSetDefault = async (id: string) => {
        try {
            await setDefaultProvider.mutateAsync(id);
            toast.success("Default provider updated.");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to set default provider.");
        }
    };

    const handleToggle = async (id: string, isEnabled: boolean) => {
        try {
            await toggleProvider.mutateAsync({ id, isEnabled });
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to update provider.");
        }
    };

    const handleConfirmDelete = async () => {
        if (!pendingDelete) return;
        try {
            await deleteProvider.mutateAsync(pendingDelete.id);
            toast.success("Provider deleted.");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to delete provider.");
        } finally {
            setPendingDelete(null);
        }
    };

    return (
        <div className="space-y-6">
            <PageHeader
                icon={Server}
                title="LLM Providers"
                description="Manage LLM providers for chat inference and embeddings."
                actions={
                    <GatedButton action="update" subject="Provider" asChild>
                        <Link href="/app/agent-ops/providers/new">
                            <Plus className="mr-2 h-4 w-4" />
                            New Provider
                        </Link>
                    </GatedButton>
                }
            />

            {error && <p className="text-sm text-destructive">{error}</p>}

            {providersQuery.isLoading ? (
                <SpinnerOverlay label="Loading providers..." />
            ) : providers.length === 0 ? (
                <Card>
                    <CardHeader>
                        <CardTitle>No providers configured</CardTitle>
                        <CardDescription>
                            Add an LLM provider to power chat inference and embeddings for your
                            organization.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <GatedButton action="update" subject="Provider" asChild>
                            <Link href="/app/agent-ops/providers/new">
                                <Plus className="mr-2 h-4 w-4" />
                                New Provider
                            </Link>
                        </GatedButton>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4">
                    {providers.map((p) => (
                        <Card key={p.id}>
                            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                                <div className="min-w-0 space-y-1">
                                    <div className="flex items-center gap-2">
                                        <CardTitle className="text-lg">{p.name}</CardTitle>
                                        <Badge variant="outline" className="text-xs font-normal">
                                            {providerLabel(p.provider)}
                                        </Badge>
                                        {p.isDefault && (
                                            <Badge variant="secondary" className="text-xs">
                                                Default
                                            </Badge>
                                        )}
                                    </div>
                                    <CardDescription className="flex items-center gap-2">
                                        {p.credentialsConfigured ? (
                                            <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-500">
                                                <CheckCircle2 className="h-3.5 w-3.5" />
                                                Credentials configured
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                                                <span className="inline-block size-2 rounded-full bg-muted-foreground/40" />
                                                No credentials
                                            </span>
                                        )}
                                    </CardDescription>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    <span
                                        className={!canWrite ? "inline-flex cursor-not-allowed" : undefined}
                                        title={!canWrite ? (writeDenial ?? undefined) : undefined}
                                    >
                                        <Switch
                                            checked={p.isEnabled}
                                            disabled={!canWrite}
                                            onCheckedChange={(v) => handleToggle(p.id, v)}
                                            aria-label="Toggle provider"
                                        />
                                    </span>
                                    <GatedButton
                                        action="update"
                                        subject="Provider"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => handleRefresh(p.id)}
                                        disabled={refreshingId === p.id}
                                        title="Refresh models"
                                    >
                                        {refreshingId === p.id ? (
                                            <Spinner size="sm" />
                                        ) : (
                                            <RefreshCw className="h-4 w-4" />
                                        )}
                                    </GatedButton>
                                    <GatedButton
                                        action="update"
                                        subject="Provider"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => handleSetDefault(p.id)}
                                        disabled={p.isDefault}
                                        title={p.isDefault ? "Default provider" : "Set as default"}
                                    >
                                        <Star
                                            className={cn(
                                                "h-4 w-4",
                                                p.isDefault && "fill-yellow-400 text-yellow-400",
                                            )}
                                        />
                                    </GatedButton>
                                    <GatedButton action="update" subject="Provider" variant="ghost" size="icon" asChild title="Edit provider">
                                        <Link href={`/app/agent-ops/providers/${p.id}/edit`}>
                                            <Pencil className="h-4 w-4" />
                                        </Link>
                                    </GatedButton>
                                    <GatedButton
                                        action="update"
                                        subject="Provider"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => setPendingDelete(p)}
                                        title="Delete provider"
                                    >
                                        <Trash2 className="h-4 w-4 text-destructive" />
                                    </GatedButton>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                                    <div>
                                        <span className="text-muted-foreground">Chat model: </span>
                                        {p.chatModel ? (
                                            <span className="font-medium">{p.chatModel}</span>
                                        ) : (
                                            <span className="text-muted-foreground">No model selected</span>
                                        )}
                                    </div>
                                    <div>
                                        <span className="text-muted-foreground">Models: </span>
                                        <span className="font-medium">{p.models.length}</span>
                                    </div>
                                    {p.embeddingModel && (
                                        <div>
                                            <span className="text-muted-foreground">Embedding: </span>
                                            <span className="font-medium">{p.embeddingModel}</span>
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            <AlertDialog
                open={pendingDelete !== null}
                onOpenChange={(open) => !open && setPendingDelete(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete provider?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This will permanently remove{" "}
                            <span className="font-medium">{pendingDelete?.name}</span> and its stored
                            credentials. This action cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleConfirmDelete}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
