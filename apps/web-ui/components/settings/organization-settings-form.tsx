"use client";

import { useState, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useSession } from "next-auth/react";
import { useTenant } from "@/lib/tenant-context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Upload } from "lucide-react";
import { useCan } from "@/hooks/use-can";

const orgSettingsSchema = z.object({
    name: z.string().min(1, "Organization name is required").max(100),
    timezone: z.string().min(1, "Timezone is required"),
    notifications: z.object({
        scheduleExecutions: z.boolean(),
        memberInvites: z.boolean(),
        systemAlerts: z.boolean(),
    }),
});

type OrgSettingsFormData = z.infer<typeof orgSettingsSchema>;

interface OrgSettings {
    name: string;
    slug: string;
    timezone: string;
    notifications: {
        scheduleExecutions: boolean;
        memberInvites: boolean;
        systemAlerts: boolean;
    };
    logoUrl?: string | null;
}

const TIMEZONES = Intl.supportedValuesOf("timeZone");

export function OrganizationSettingsForm() {
    const { data: session } = useSession();
    const { refetch: refetchTenant } = useTenant();
    const [slug, setSlug] = useState("");
    const [currentLogoUrl, setCurrentLogoUrl] = useState<string | null>(null);
    const [logoError, setLogoError] = useState<string | null>(null);
    const [logoUploading, setLogoUploading] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const isSuperAdmin = session?.user?.isSuperAdmin as boolean | undefined;
    // PUT /api/tenants/settings and both handlers in /api/tenants/logo require
    // `update Tenant` — read the routes, not this comment's ancestor, which
    // claimed `update Settings` and was wrong.
    //
    // That mismatch is why the controls stayed live for a role the API refuses:
    // 'Settings' is the module-wide catch-all the role editor HIDES, so anyone
    // holding the Settings module passed this check, while the server asked
    // about the 'Tenant' row — a real, visible submodule that governed nothing
    // here. Asking the same question the route answers puts that row in charge.
    //
    // Whole-section hide (not a per-field tooltip) is intentional and kept: a
    // Member/Viewer should not know edit controls exist here.
    const canEdit = useCan("update", "Tenant") || isSuperAdmin === true;

    const {
        register,
        handleSubmit,
        setValue,
        watch,
        formState: { errors, isSubmitting },
    } = useForm<OrgSettingsFormData>({
        resolver: zodResolver(orgSettingsSchema),
        defaultValues: {
            name: "",
            timezone: "UTC",
            notifications: {
                scheduleExecutions: true,
                memberInvites: true,
                systemAlerts: true,
            },
        },
    });

    const notifications = watch("notifications");
    const timezone = watch("timezone");

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const res = await fetch("/api/tenants/settings");
                if (res.ok) {
                    const json = await res.json();
                    const data: OrgSettings = json.data;
                    setValue("name", data.name ?? "");
                    setValue("timezone", data.timezone ?? "UTC");
                    setValue("notifications.scheduleExecutions", data.notifications?.scheduleExecutions ?? true);
                    setValue("notifications.memberInvites", data.notifications?.memberInvites ?? true);
                    setValue("notifications.systemAlerts", data.notifications?.systemAlerts ?? true);
                    setSlug(data.slug ?? "");
                    setCurrentLogoUrl(data.logoUrl ?? null);
                }
            } catch (err) {
                console.error("Failed to fetch org settings:", err);
            } finally {
                setLoading(false);
            }
        };
        fetchSettings();
    }, [setValue]);

    const onSubmit = async (data: OrgSettingsFormData) => {
        setSaveError(null);
        setSaveSuccess(false);
        try {
            const res = await fetch("/api/tenants/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: data.name,
                    timezone: data.timezone,
                    notifications: data.notifications,
                }),
            });
            if (!res.ok) {
                const json = await res.json();
                setSaveError(json.error ?? "Failed to save settings.");
                return;
            }
            setSaveSuccess(true);
            setTimeout(() => setSaveSuccess(false), 3000);
            await refetchTenant();
        } catch {
            setSaveError("Failed to save settings.");
        }
    };

    const handleLogoUpload = async (file: File) => {
        setLogoError(null);
        if (file.size > 2 * 1024 * 1024) {
            setLogoError("Max file size is 2MB");
            return;
        }
        setLogoUploading(true);
        try {
            const ext = file.name.split(".").pop() ?? "png";
            // 1. Get presigned URL
            const presignRes = await fetch("/api/tenants/logo", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contentType: file.type, size: file.size, ext }),
            });
            if (!presignRes.ok) {
                setLogoError("Failed to get upload URL.");
                return;
            }
            const { url, key } = await presignRes.json();
            // 2. Upload to S3
            const s3Res = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
            if (!s3Res.ok) {
                setLogoError("Logo upload failed. Check your storage configuration.");
                return;
            }
            // 3. Save key
            const saveRes = await fetch("/api/tenants/logo", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key }),
            });
            if (!saveRes.ok) {
                setLogoError("Failed to save logo.");
                return;
            }
            const { logoUrl } = await saveRes.json();
            setCurrentLogoUrl(logoUrl);
        } catch {
            setLogoError("Logo upload failed.");
        } finally {
            setLogoUploading(false);
        }
    };

    const getOrgInitial = (name: string) => name.charAt(0).toUpperCase();
    const orgName = watch("name");

    if (loading) {
        return (
            <div className="flex-1 p-4 md:p-8 pt-6">
                <p className="text-muted-foreground text-sm">Loading organization settings...</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center space-x-2">
                <h2 className="text-3xl font-bold tracking-tight text-foreground">Organization</h2>
            </div>
            <p className="text-muted-foreground">Manage your organization&apos;s display settings and preferences.</p>

            <form onSubmit={handleSubmit(onSubmit)}>
                <Card>
                    <CardHeader>
                        <CardTitle>Organization Settings</CardTitle>
                        <CardDescription>Manage your organization&apos;s display settings</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {/* Logo upload */}
                        <div className="space-y-2">
                            <Label>Organization Logo</Label>
                            <div className="flex items-center gap-4">
                                <div
                                    className="relative group cursor-pointer"
                                    onClick={() => canEdit && fileInputRef.current?.click()}
                                >
                                    <Avatar className="h-16 w-16 rounded-md">
                                        <AvatarImage src={currentLogoUrl ?? undefined} alt={orgName} />
                                        <AvatarFallback className="rounded-md bg-primary text-primary-foreground text-xl font-medium">
                                            {orgName ? getOrgInitial(orgName) : "O"}
                                        </AvatarFallback>
                                    </Avatar>
                                    {canEdit && (
                                        <div className="absolute inset-0 bg-black/50 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Upload className="h-5 w-5 text-white" />
                                        </div>
                                    )}
                                </div>
                                {canEdit && (
                                    <div className="space-y-1">
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => fileInputRef.current?.click()}
                                            disabled={logoUploading}
                                        >
                                            {logoUploading ? "Uploading..." : "Change Logo"}
                                        </Button>
                                        <p className="text-xs text-muted-foreground">PNG, JPG, SVG up to 2MB</p>
                                    </div>
                                )}
                            </div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/png,image/jpeg,image/svg+xml"
                                className="hidden"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) handleLogoUpload(file);
                                    e.target.value = "";
                                }}
                            />
                            {logoError && <p className="text-sm text-destructive">{logoError}</p>}
                        </div>

                        {/* Organization name */}
                        <div className="space-y-2">
                            <Label htmlFor="name">Organization Name</Label>
                            <Input
                                id="name"
                                {...register("name")}
                                disabled={!canEdit}
                                placeholder="My Organization"
                            />
                            {errors.name && (
                                <p className="text-sm text-destructive">{errors.name.message}</p>
                            )}
                        </div>

                        {/* Slug (read-only) */}
                        <div className="space-y-2">
                            <Label htmlFor="slug">Slug</Label>
                            <Input
                                id="slug"
                                value={slug}
                                disabled
                                className="bg-muted text-muted-foreground"
                            />
                            <p className="text-xs text-muted-foreground">Slug cannot be changed after creation.</p>
                        </div>

                        {/* Timezone */}
                        <div className="space-y-2">
                            <Label htmlFor="timezone">Timezone</Label>
                            <Select
                                value={timezone}
                                onValueChange={(val) => setValue("timezone", val)}
                                disabled={!canEdit}
                            >
                                <SelectTrigger id="timezone">
                                    <SelectValue placeholder="Select timezone" />
                                </SelectTrigger>
                                <SelectContent className="max-h-60">
                                    {TIMEZONES.map((tz) => (
                                        <SelectItem key={tz} value={tz}>
                                            {tz}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {errors.timezone && (
                                <p className="text-sm text-destructive">{errors.timezone.message}</p>
                            )}
                        </div>

                        {/* Notifications */}
                        <div className="space-y-4">
                            <Label>Notifications</Label>
                            <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-sm font-medium">Schedule Executions</p>
                                        <p className="text-xs text-muted-foreground">Notify when schedules run</p>
                                    </div>
                                    <Switch
                                        checked={notifications.scheduleExecutions}
                                        onCheckedChange={(val) => setValue("notifications.scheduleExecutions", val)}
                                        disabled={!canEdit}
                                    />
                                </div>
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-sm font-medium">Member Invites</p>
                                        <p className="text-xs text-muted-foreground">Notify when members are invited</p>
                                    </div>
                                    <Switch
                                        checked={notifications.memberInvites}
                                        onCheckedChange={(val) => setValue("notifications.memberInvites", val)}
                                        disabled={!canEdit}
                                    />
                                </div>
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-sm font-medium">System Alerts</p>
                                        <p className="text-xs text-muted-foreground">Notify on system-level events</p>
                                    </div>
                                    <Switch
                                        checked={notifications.systemAlerts}
                                        onCheckedChange={(val) => setValue("notifications.systemAlerts", val)}
                                        disabled={!canEdit}
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Save feedback */}
                        {saveError && <p className="text-sm text-destructive">{saveError}</p>}
                        {saveSuccess && <p className="text-sm text-green-600">Settings saved successfully.</p>}

                        {/* Save button — hidden for Viewer/Member */}
                        {canEdit && (
                            <Button type="submit" disabled={isSubmitting}>
                                {isSubmitting ? "Saving..." : "Save Changes"}
                            </Button>
                        )}
                    </CardContent>
                </Card>
            </form>
        </div>
    );
}
