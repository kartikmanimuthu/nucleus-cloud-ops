"use client";

import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { Loader2, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useAccounts } from "@/lib/queries/accounts";
import { useDeployCertificate } from "@/lib/queries/certificates";

const deploySchema = z.object({
    accountId: z.string().min(1, "Please select an account"),
    region: z.string().min(1, "Please select a region"),
});

type DeployFormValues = z.infer<typeof deploySchema>;

interface RegionOption {
    value: string;
    label: string;
}

interface DeployCertificateDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    certificateId: string;
    excludedAccountIds?: string[];
}

export function DeployCertificateDialog({
    open,
    onOpenChange,
    certificateId,
    excludedAccountIds = [],
}: DeployCertificateDialogProps) {
    const deploy = useDeployCertificate();
    const { data: accountsData, isLoading: loadingAccounts } = useAccounts({ limit: 1000 });

    const { data: regions = [], isLoading: loadingRegions } = useQuery({
        queryKey: ["regions"],
        enabled: open,
        queryFn: async (): Promise<RegionOption[]> => {
            const res = await fetch("/api/regions");
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || "Failed to load regions");
            }
            return json.data as RegionOption[];
        },
    });

    const accounts = useMemo(() => {
        const all = accountsData?.accounts ?? [];
        return all.filter((a) => a.active && !excludedAccountIds.includes(a.accountId));
    }, [accountsData, excludedAccountIds]);

    const form = useForm<DeployFormValues>({
        resolver: zodResolver(deploySchema),
        defaultValues: { accountId: "", region: "" },
    });

    const handleClose = (next: boolean) => {
        if (!next) form.reset();
        onOpenChange(next);
    };

    const onAccountChange = (accountId: string) => {
        form.setValue("accountId", accountId, { shouldValidate: true });
        const account = accounts.find((a) => a.accountId === accountId);
        const defaultRegion = account?.regions?.[0] ?? "us-east-1";
        form.setValue("region", defaultRegion, { shouldValidate: true });
    };

    const onSubmit = async (values: DeployFormValues) => {
        try {
            await deploy.mutateAsync({
                certId: certificateId,
                accountId: values.accountId,
                region: values.region,
            });
            toast.success("Certificate deployed", {
                description: `Account ${values.accountId} / ${values.region}`,
            });
            form.reset();
            onOpenChange(false);
        } catch (e) {
            toast.error("Deploy failed", {
                description: e instanceof Error ? e.message : "Please try again",
            });
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Deploy to Account</DialogTitle>
                    <DialogDescription>
                        Import this certificate into a new AWS account via ACM.
                    </DialogDescription>
                </DialogHeader>

                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-2">
                        <FormField
                            control={form.control}
                            name="accountId"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>AWS Account</FormLabel>
                                    <Select
                                        value={field.value}
                                        onValueChange={onAccountChange}
                                        disabled={loadingAccounts || accounts.length === 0}
                                    >
                                        <FormControl>
                                            <SelectTrigger className="w-full">
                                                <SelectValue
                                                    placeholder={
                                                        loadingAccounts
                                                            ? "Loading accounts..."
                                                            : accounts.length === 0
                                                              ? "No available accounts"
                                                              : "Select an account"
                                                    }
                                                />
                                            </SelectTrigger>
                                        </FormControl>
                                        <SelectContent>
                                            {accounts.map((account) => (
                                                <SelectItem
                                                    key={account.accountId}
                                                    value={account.accountId}
                                                >
                                                    {account.name}{" "}
                                                    <span className="text-muted-foreground text-xs">
                                                        ({account.accountId})
                                                    </span>
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    {accounts.length === 0 && !loadingAccounts && (
                                        <FormDescription>
                                            All accounts already have this certificate.
                                        </FormDescription>
                                    )}
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <FormField
                            control={form.control}
                            name="region"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Region</FormLabel>
                                    <Select
                                        value={field.value}
                                        onValueChange={field.onChange}
                                        disabled={!form.watch("accountId") || loadingRegions}
                                    >
                                        <FormControl>
                                            <SelectTrigger className="w-full">
                                                <SelectValue
                                                    placeholder={
                                                        loadingRegions
                                                            ? "Loading regions..."
                                                            : "Select a region"
                                                    }
                                                />
                                            </SelectTrigger>
                                        </FormControl>
                                        <SelectContent>
                                            {regions.map((region) => (
                                                <SelectItem key={region.value} value={region.value}>
                                                    {region.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <FormDescription>
                                        Choose us-east-1 if this certificate will be used with
                                        CloudFront.
                                    </FormDescription>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => handleClose(false)}
                                disabled={deploy.isPending}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={deploy.isPending}>
                                {deploy.isPending ? (
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                ) : (
                                    <UploadCloud className="h-4 w-4 mr-2" />
                                )}
                                Deploy
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}
