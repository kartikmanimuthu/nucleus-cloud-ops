"use client";

import React, { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Zap, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const createOrgSchema = z.object({
    name: z.string().min(1, "Organization name is required").max(100),
    slug: z
        .string()
        .min(3, "Slug must be 3-50 lowercase letters, numbers, or hyphens")
        .max(50, "Slug must be 3-50 lowercase letters, numbers, or hyphens")
        .regex(
            /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
            "Slug must be 3-50 lowercase letters, numbers, or hyphens"
        ),
});

type CreateOrgFormData = z.infer<typeof createOrgSchema>;

type SlugStatus = "idle" | "checking" | "available" | "taken";

export default function CreateOrgPage() {
    const router = useRouter();
    const { data: session, status, update } = useSession();
    const [isLoading, setIsLoading] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const [slugStatus, setSlugStatus] = useState<SlugStatus>("idle");
    const slugTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const {
        register,
        handleSubmit,
        getValues,
        setError,
        formState: { errors },
    } = useForm<CreateOrgFormData>({
        resolver: zodResolver(createOrgSchema),
    });

    // Redirect if already has a tenant
    React.useEffect(() => {
        if (status === "unauthenticated") {
            router.push("/login");
        }
        if (status === "authenticated" && session?.user?.tenantId) {
            router.push("/app/dashboard");
        }
    }, [status, session, router]);

    const checkSlugAvailability = useCallback(async (slug: string) => {
        if (!slug || slug.length < 3 || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
            setSlugStatus("idle");
            return;
        }
        setSlugStatus("checking");
        try {
            const res = await fetch(
                `/api/tenants/check-slug?slug=${encodeURIComponent(slug)}`
            );
            const data = await res.json();
            setSlugStatus(data.available ? "available" : "taken");
        } catch {
            setSlugStatus("idle");
        }
    }, []);

    const handleSlugBlur = () => {
        const slug = getValues("slug");
        if (slugTimeoutRef.current) clearTimeout(slugTimeoutRef.current);
        slugTimeoutRef.current = setTimeout(() => checkSlugAvailability(slug), 300);
    };

    const onSubmit = async (data: CreateOrgFormData) => {
        if (slugStatus === "checking" || slugStatus === "taken") return;

        setIsLoading(true);
        setServerError(null);
        try {
            const res = await fetch("/api/tenants", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: data.name, slug: data.slug }),
            });
            const json = await res.json();

            if (res.status === 409) {
                if (json.error?.toLowerCase().includes("slug")) {
                    setError("slug", {
                        message: "This slug is already taken. Try another.",
                    });
                    setSlugStatus("taken");
                } else {
                    setServerError(json.error ?? "Failed to create organization. Please try again.");
                }
                return;
            }

            if (!res.ok) {
                setServerError(
                    json.error ?? "Failed to create organization. Please try again."
                );
                return;
            }

            // Refresh session to pick up new tenantId
            await update();
            router.push("/app/dashboard");
        } catch {
            setServerError("Failed to create organization. Please try again.");
        } finally {
            setIsLoading(false);
        }
    };

    if (status === "loading") {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center p-4">
                <div className="w-full max-w-sm">
                    <div className="bg-card border border-border rounded-xl shadow-sm p-8">
                        <div className="space-y-4">
                            <Skeleton className="h-4 w-3/4" />
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
            <div className="w-full max-w-sm">
                <div className="bg-card border border-border rounded-xl shadow-sm p-8">
                    {/* Logo row */}
                    <div className="flex items-center gap-2 mb-6">
                        <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
                            <Zap className="w-4 h-4 text-primary-foreground" />
                        </div>
                        <span className="font-bold text-lg text-foreground">Nucleus Ops</span>
                    </div>

                    {/* Heading block */}
                    <div className="mb-6">
                        <h1 className="text-2xl font-bold text-foreground leading-[1.2]">
                            Create your organization
                        </h1>
                        <p className="text-sm text-muted-foreground mt-1">
                            Set up your workspace to get started
                        </p>
                    </div>

                    <form onSubmit={handleSubmit(onSubmit)} noValidate>
                        <div className="space-y-4">
                            {/* Org name field */}
                            <div className="space-y-2">
                                <Label htmlFor="name" className="text-sm">
                                    Organization name
                                </Label>
                                <Input
                                    id="name"
                                    type="text"
                                    placeholder="Acme Corp"
                                    {...register("name")}
                                    aria-describedby={errors.name ? "name-error" : undefined}
                                    className={cn(errors.name && "border-destructive")}
                                    disabled={isLoading}
                                />
                                {errors.name && (
                                    <p
                                        id="name-error"
                                        className="text-xs text-destructive mt-1"
                                        role="alert"
                                    >
                                        {errors.name.message}
                                    </p>
                                )}
                            </div>

                            {/* Slug field */}
                            <div className="space-y-2">
                                <Label htmlFor="slug" className="text-sm">
                                    Slug
                                </Label>
                                <div className="relative">
                                    <Input
                                        id="slug"
                                        type="text"
                                        placeholder="acme-corp"
                                        {...register("slug")}
                                        onBlur={handleSlugBlur}
                                        aria-describedby={
                                            errors.slug
                                                ? "slug-error"
                                                : slugStatus === "taken"
                                                ? "slug-taken"
                                                : "slug-hint"
                                        }
                                        className={cn(
                                            "pr-8",
                                            (errors.slug || slugStatus === "taken") &&
                                                "border-destructive",
                                            slugStatus === "available" && "border-primary"
                                        )}
                                        disabled={isLoading}
                                    />
                                    <div className="absolute right-2 top-1/2 -translate-y-1/2">
                                        {slugStatus === "checking" && (
                                            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                                        )}
                                        {slugStatus === "available" && (
                                            <CheckCircle2 className="w-4 h-4 text-primary" />
                                        )}
                                        {slugStatus === "taken" && (
                                            <XCircle className="w-4 h-4 text-destructive" />
                                        )}
                                    </div>
                                </div>
                                <p id="slug-hint" className="text-xs text-muted-foreground">
                                    Lowercase letters, numbers, and hyphens only. 3-50 characters.
                                </p>
                                {errors.slug && (
                                    <p
                                        id="slug-error"
                                        className="text-xs text-destructive mt-1"
                                        role="alert"
                                    >
                                        {errors.slug.message}
                                    </p>
                                )}
                                {!errors.slug && slugStatus === "available" && (
                                    <p className="text-xs text-primary">Slug is available</p>
                                )}
                                {!errors.slug && slugStatus === "taken" && (
                                    <p
                                        id="slug-taken"
                                        className="text-xs text-destructive"
                                        role="alert"
                                    >
                                        This slug is already taken. Try another.
                                    </p>
                                )}
                            </div>

                            {/* Server error */}
                            {serverError && (
                                <div className="text-sm text-destructive" role="alert">
                                    {serverError}
                                </div>
                            )}

                            {/* Submit button */}
                            <Button
                                type="submit"
                                className="w-full h-11"
                                disabled={
                                    isLoading ||
                                    slugStatus === "checking" ||
                                    slugStatus === "taken"
                                }
                            >
                                {isLoading ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Creating organization...
                                    </>
                                ) : (
                                    "Create organization"
                                )}
                            </Button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}
