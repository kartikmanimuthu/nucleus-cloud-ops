"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Database } from "lucide-react";
import { DiscoverySettings } from "@/components/settings/discovery-settings";

export default function InventorySettingsPage() {
    const router = useRouter();

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

            <DiscoverySettings canEdit={true} />
        </div>
    );
}
