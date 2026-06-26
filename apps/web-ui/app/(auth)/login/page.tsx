"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";

const credentialsSchema = z.object({
    email: z.string().email("Please enter a valid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
});

type CredentialsFormData = z.infer<typeof credentialsSchema>;

export default function LoginPage() {
    const router = useRouter();
    const { status } = useSession();
    const [isLoading, setIsLoading] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const [isSsoLoading, setIsSsoLoading] = useState(false);
    const [ssoError, setSsoError] = useState<string | null>(null);

    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<CredentialsFormData>({
        resolver: zodResolver(credentialsSchema),
    });

    useEffect(() => {
        if (status === "authenticated") {
            router.push("/app/dashboard");
        }
    }, [status, router]);

    const onCredentialsSubmit = async (data: CredentialsFormData) => {
        setIsLoading(true);
        setServerError(null);
        try {
            const result = await signIn("credentials", {
                email: data.email,
                password: data.password,
                redirect: false,
            });
            if (result?.error) {
                setServerError(
                    result.error === "CredentialsSignin"
                        ? "Invalid email or password."
                        : result.error
                );
            } else if (result?.ok) {
                router.push("/app/dashboard");
            }
        } catch {
            setServerError("An unexpected error occurred. Please try again.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleSsoSignIn = async () => {
        setIsSsoLoading(true);
        setSsoError(null);
        try {
            await signIn("cognito", { callbackUrl: "/app/dashboard" });
        } catch {
            setSsoError("SSO sign-in failed. Please try again or contact support.");
            setIsSsoLoading(false);
        }
    };

    // Logo badge shown above the card (reference parity).
    const brand = (
        <span className="flex items-center gap-2 self-center font-medium">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Zap className="size-4" />
            </span>
            Nucleus Ops
        </span>
    );

    if (status === "loading") {
        return (
            <>
                {brand}
                <Card>
                    <CardContent className="space-y-4 pt-6">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                    </CardContent>
                </Card>
            </>
        );
    }

    return (
        <>
            {brand}
            <Card>
                <CardHeader className="text-center">
                    <CardTitle className="text-xl">Welcome back</CardTitle>
                    <CardDescription>Sign in to your account to continue</CardDescription>
                </CardHeader>
                <CardContent>
                    {/* Tabs */}
                    <Tabs defaultValue="credentials">
                        <TabsList className="grid w-full grid-cols-2 mb-6" aria-disabled={isLoading || isSsoLoading}>
                            <TabsTrigger value="credentials" disabled={isLoading || isSsoLoading}>Email &amp; Password</TabsTrigger>
                            <TabsTrigger value="sso" disabled={isLoading || isSsoLoading}>SSO</TabsTrigger>
                        </TabsList>

                        {/* Credentials tab */}
                        <TabsContent value="credentials">
                            <form onSubmit={handleSubmit(onCredentialsSubmit)} noValidate>
                                <fieldset disabled={isLoading} className="border-0 p-0 m-0 min-w-0">
                                <div className="space-y-4">
                                    {/* Email field */}
                                    <div className="space-y-2">
                                        <Label htmlFor="email" className="text-sm">
                                            Email
                                        </Label>
                                        <Input
                                            id="email"
                                            type="email"
                                            placeholder="you@example.com"
                                            {...register("email")}
                                            aria-describedby={errors.email ? "email-error" : undefined}
                                            className={cn(errors.email && "border-destructive")}
                                            disabled={isLoading}
                                        />
                                        {errors.email && (
                                            <p
                                                id="email-error"
                                                className="text-xs text-destructive mt-1"
                                                role="alert"
                                            >
                                                {errors.email.message}
                                            </p>
                                        )}
                                    </div>

                                    {/* Password field */}
                                    <div className="space-y-2">
                                        <Label htmlFor="password" className="text-sm">
                                            Password
                                        </Label>
                                        <Input
                                            id="password"
                                            type="password"
                                            {...register("password")}
                                            aria-describedby={errors.password ? "password-error" : undefined}
                                            className={cn(errors.password && "border-destructive")}
                                            disabled={isLoading}
                                        />
                                        {errors.password && (
                                            <p
                                                id="password-error"
                                                className="text-xs text-destructive mt-1"
                                                role="alert"
                                            >
                                                {errors.password.message}
                                            </p>
                                        )}
                                    </div>

                                    {/* Forgot password */}
                                    <div className="flex justify-end">
                                        <a
                                            href="/api/auth/forgot-password"
                                            className={cn(
                                                "text-sm text-primary underline-offset-4",
                                                isLoading
                                                    ? "pointer-events-none opacity-50"
                                                    : "hover:underline"
                                            )}
                                            aria-disabled={isLoading}
                                            tabIndex={isLoading ? -1 : undefined}
                                        >
                                            Forgot password?
                                        </a>
                                    </div>

                                    {/* Server error */}
                                    {serverError && (
                                        <div
                                            className="text-sm text-destructive"
                                            role="alert"
                                        >
                                            {serverError}
                                        </div>
                                    )}

                                    {/* Submit button */}
                                    <Button
                                        type="submit"
                                        className="w-full h-11"
                                        disabled={isLoading}
                                    >
                                        {isLoading ? (
                                            <>
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                Signing in...
                                            </>
                                        ) : (
                                            "Sign in"
                                        )}
                                    </Button>
                                </div>
                                </fieldset>
                            </form>
                        </TabsContent>

                        {/* SSO tab */}
                        <TabsContent value="sso">
                            <p className="text-sm text-muted-foreground mb-4">
                                Sign in using your organization&apos;s SSO provider.
                            </p>
                            {ssoError && (
                                <div
                                    className="text-sm text-destructive mb-4"
                                    role="alert"
                                >
                                    {ssoError}
                                </div>
                            )}
                            <Button
                                onClick={handleSsoSignIn}
                                className="w-full h-11"
                                disabled={isSsoLoading}
                            >
                                {isSsoLoading ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Signing in...
                                    </>
                                ) : (
                                    "Sign in with SSO"
                                )}
                            </Button>
                        </TabsContent>
                    </Tabs>
                </CardContent>
            </Card>

            {/* Footer */}
            <p className="text-center text-sm text-muted-foreground">
                Don&apos;t have an account?{" "}
                <Link
                    href="/signup"
                    className="text-primary hover:underline underline-offset-4"
                >
                    Sign up
                </Link>
            </p>
        </>
    );
}
