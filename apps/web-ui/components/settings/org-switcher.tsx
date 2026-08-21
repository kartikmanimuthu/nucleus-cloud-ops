"use client";

import { useMyOrgs, useSwitchOrg, type Org } from "@/lib/queries/orgs";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from "@/components/ui/sidebar";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useCan, useDenialReason } from "@/hooks/use-can";

export function OrgSwitcher() {
    const { data: session, update } = useSession();
    const { isMobile } = useSidebar();
    const router = useRouter();
    const orgsQuery = useMyOrgs();
    const switchOrg = useSwitchOrg();
    const orgs: Org[] = orgsQuery.data ?? [];
    const loading = orgsQuery.isLoading;

    const currentTenantId = session?.user?.tenantId;

    const handleSwitch = async (tenantId: string) => {
        if (tenantId === currentTenantId) return;
        try {
            await switchOrg.mutateAsync(tenantId);
            // update() refreshes session, then router.refresh() re-renders server components
            await update();
            router.refresh();
        } catch (err) {
            console.error("Failed to switch org:", err);
        }
    };

    /**
     * `/api/tenants/my-orgs` requires `read Tenant`, a Settings-module permission.
     * A role without Settings gets an empty list, and this component used to
     * `return null` — the whole switcher disappeared and the user had no way to
     * tell which organisation they were in.
     *
     * The active org's name now travels on the session, so identity is always
     * shown. The list is still permission-gated: without `read Tenant` there is
     * simply nothing to switch between.
     */
    const currentOrg: Org | undefined =
        orgs.find((o) => o.id === currentTenantId) ??
        (currentTenantId && session?.user?.tenantName
            ? ({ id: currentTenantId, name: session.user.tenantName, logoUrl: null } as Org)
            : undefined);

    const isMultiOrg = orgs.length > 1;

    // Creating and switching are real mutations and stay gated independently of
    // merely SEEING which org you are in.
    const canCreateOrg = useCan("create", "Tenant");
    const createDenialReason = useDenialReason("create", "Tenant");
    const canSwitchOrg = useCan("update", "Tenant");

    const getOrgInitial = (name: string) => name.charAt(0).toUpperCase();

    if (loading) {
        return (
            <SidebarMenu>
                <SidebarMenuItem>
                    <div className="flex items-center gap-2 p-2">
                        <div className="size-8 rounded-md bg-sidebar-accent animate-pulse" />
                        <div className="h-4 w-24 bg-sidebar-accent animate-pulse rounded group-data-[collapsible=icon]:hidden" />
                    </div>
                </SidebarMenuItem>
            </SidebarMenu>
        );
    }

    if (!currentOrg) return null;

    // Shared "Create new organization" menu item. Rendered disabled rather than
    // hidden when denied, so the capability stays discoverable and the tooltip
    // explains why it is unavailable.
    const createOrgItem = (
        <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
                onClick={canCreateOrg ? () => router.push("/create-org") : undefined}
                onSelect={canCreateOrg ? undefined : (e) => e.preventDefault()}
                disabled={!canCreateOrg}
                aria-disabled={!canCreateOrg || undefined}
                title={canCreateOrg ? undefined : (createDenialReason ?? undefined)}
                className={`flex items-center gap-2 ${canCreateOrg ? "cursor-pointer" : "cursor-not-allowed"}`}
            >
                <div className="flex size-6 items-center justify-center rounded-md border border-dashed border-muted-foreground/50 shrink-0">
                    <Plus className="size-3.5 text-muted-foreground" />
                </div>
                <span className="text-sm text-muted-foreground">Create new organization</span>
            </DropdownMenuItem>
        </>
    );

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size="lg"
                            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                        >
                            <Avatar className="size-8 rounded-md shrink-0">
                                <AvatarImage src={currentOrg.logoUrl ?? undefined} alt={currentOrg.name} />
                                <AvatarFallback className="rounded-md bg-primary text-primary-foreground text-xs font-medium">
                                    {getOrgInitial(currentOrg.name)}
                                </AvatarFallback>
                            </Avatar>
                            <span className="font-semibold text-sm truncate flex-1 text-left">
                                {currentOrg.name}
                            </span>
                            <ChevronsUpDown className="ml-auto size-4 text-muted-foreground shrink-0" />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        className="w-60 rounded-lg"
                        align="start"
                        side={isMobile ? "bottom" : "right"}
                        sideOffset={4}
                    >
                        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                            {isMultiOrg ? "Switch organization" : "Organization"}
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {orgs.map((org) => (
                            <DropdownMenuItem
                                key={org.id}
                                onClick={canSwitchOrg ? () => handleSwitch(org.id) : undefined}
                                onSelect={canSwitchOrg ? undefined : (e) => e.preventDefault()}
                                disabled={!canSwitchOrg && org.id !== currentTenantId}
                                className={`flex items-center gap-2 ${canSwitchOrg ? "cursor-pointer" : "cursor-not-allowed"}`}
                            >
                                <Avatar className="size-6 rounded-md shrink-0">
                                    <AvatarImage src={org.logoUrl ?? undefined} alt={org.name} />
                                    <AvatarFallback className="rounded-md bg-muted text-muted-foreground text-xs">
                                        {getOrgInitial(org.name)}
                                    </AvatarFallback>
                                </Avatar>
                                <span className="truncate flex-1 text-sm">{org.name}</span>
                                {org.id === currentTenantId && (
                                    <Check className="size-4 text-primary shrink-0" />
                                )}
                            </DropdownMenuItem>
                        ))}
                        {createOrgItem}
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}
