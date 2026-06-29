"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProviderWizard } from "@/components/settings/provider-wizard";

export default function NewProviderPage() {
    return (
        <div className="mx-auto w-full max-w-2xl space-y-4 p-4 pt-6 md:p-8">
            <div className="flex items-center gap-3">
                <Button variant="ghost" size="icon" className="h-8 w-8" asChild aria-label="Back to providers">
                    <Link href="/app/settings/providers">
                        <ArrowLeft className="h-4 w-4" />
                    </Link>
                </Button>
                <h2 className="text-2xl font-bold tracking-tight">New LLM Provider</h2>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Provider Details</CardTitle>
                    <CardDescription>
                        Configure the model, endpoint, and credentials for your LLM provider.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <ProviderWizard mode="create" />
                </CardContent>
            </Card>
        </div>
    );
}
