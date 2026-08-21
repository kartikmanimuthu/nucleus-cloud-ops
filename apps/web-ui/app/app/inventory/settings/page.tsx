"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Database } from "lucide-react";
import { DiscoverySettings } from "@/components/settings/discovery-settings";
import { useCan, useDenialReason } from "@/hooks/use-can";

export default function InventorySettingsPage() {
    const router = useRouter();

    /**
     * What PUT /api/settings/discovery enforces (route.ts:58). `canEdit` was
     * hardcoded `true`, so a role without it got a live Save button and learned
     * it was denied only from the 403 — DiscoverySettings already threads
     * canEdit through to the Frequency select and Save, so all that was missing
     * was asking the question.
     *
     * Subject is 'Resource' — the "Inventory Resource" submodule row — NOT the
     * hidden 'Discovery' subject this used to ask about. This screen configures
     * how the inventory is discovered, so it belongs to the row an admin can
     * actually see and deny. Gating it on the hidden subject meant denying
     * update on Inventory Resource left Save live, because Discovery inherited
     * the Inventory module's grant instead.
     */
    const canEdit = useCan("update", "Resource");
    const canEditReason = useDenialReason("update", "Resource");

    return (
        <div className="space-y-6">
            <div className="flex items-center space-x-4">
                <Button variant="ghost" size="icon" onClick={() => router.push("/app/inventory")}>
                    <ArrowLeft className="h-5 w-5" />
                </Button>
                <div>
                    <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
                        <Database className="h-8 w-8 text-primary" />
                        Inventory Settings
                    </h1>
                    <p className="text-muted-foreground">
                        Configure discovery scan frequency for your organization
                    </p>
                </div>
            </div>

            <DiscoverySettings canEdit={canEdit} canEditReason={canEditReason} />
        </div>
    );
}
