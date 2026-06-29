"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SpinnerOverlay } from "@/components/ui/spinner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ProviderWizard } from "@/components/settings/provider-wizard";
import { useProvider } from "@/lib/queries/providers";

export default function EditProviderPage() {
    const params = useParams<{ id: string }>();
    const id = params?.id;
    const { data: provider, isLoading } = useProvider(id);

    return (
        <div className="mx-auto w-full max-w-2xl space-y-4 p-4 pt-6 md:p-8">
            <div className="flex items-center gap-3">
                <Button variant="ghost" size="icon" className="h-8 w-8" asChild aria-label="Back to providers">
                    <Link href="/app/settings/providers">
                        <ArrowLeft className="h-4 w-4" />
                    </Link>
                </Button>
                <h2 className="text-2xl font-bold tracking-tight">Edit LLM Provider</h2>
            </div>

            <Card>
                {isLoading ? (
                    <CardContent className="pt-6">
                        <SpinnerOverlay label="Loading provider..." />
                    </CardContent>
                ) : provider ? (
                    <>
                        <CardHeader>
                            <CardTitle>Provider Details</CardTitle>
                            <CardDescription>
                                Update the configuration and credentials for this LLM provider.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <ProviderWizard mode="edit" provider={provider} />
                        </CardContent>
                    </>
                ) : (
                    <>
                        <CardHeader>
                            <CardTitle>Provider not found</CardTitle>
                            <CardDescription>This provider may have been deleted.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <Button asChild variant="outline">
                                <Link href="/app/settings/providers">Back to providers</Link>
                            </Button>
                        </CardContent>
                    </>
                )}
            </Card>
        </div>
    );
}
