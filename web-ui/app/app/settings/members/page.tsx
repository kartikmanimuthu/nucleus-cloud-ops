"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Users } from "lucide-react";
import { useSession } from "next-auth/react";
import { MembersTable } from "@/components/settings/members-table";
import { InvitationsTable } from "@/components/settings/invitations-table";
import { InviteMemberDialog } from "@/components/settings/invite-member-dialog";

interface Member {
    id: string;
    userId: string;
    email: string;
    role: string;
    assignedAt: string;
}

interface Invitation {
    id: string;
    tenantId: string;
    email: string;
    role: string;
    invitedBy: string;
    status: "pending" | "accepted" | "revoked" | "expired";
    createdAt: string;
    expiresAt: string;
}

const ROLE_HIERARCHY: Record<string, number> = {
    Owner: 4,
    Admin: 3,
    Member: 2,
    Viewer: 1,
};

const ALL_ROLES = ["Owner", "Admin", "Member", "Viewer"];

export default function MembersPage() {
    const { data: session } = useSession();

    const [members, setMembers] = useState<Member[]>([]);
    const [membersLoading, setMembersLoading] = useState(true);
    const [membersError, setMembersError] = useState<string | null>(null);

    const [invitations, setInvitations] = useState<Invitation[]>([]);
    const [invitationsLoading, setInvitationsLoading] = useState(true);
    const [invitationsError, setInvitationsError] = useState<string | null>(null);

    const [customRoles, setCustomRoles] = useState<{ name: string; level: number }[]>([]);

    const [dialogOpen, setDialogOpen] = useState(false);

    const fetchMembers = useCallback(async () => {
        setMembersLoading(true);
        setMembersError(null);
        try {
            const res = await fetch("/api/settings/members");
            const json = await res.json();
            if (!res.ok || !json.success) {
                setMembersError(json.error ?? "Failed to load members. Refresh the page to try again.");
                return;
            }
            setMembers(json.data ?? []);
        } catch {
            setMembersError("Failed to load members. Refresh the page to try again.");
        } finally {
            setMembersLoading(false);
        }
    }, []);

    const fetchInvitations = useCallback(async () => {
        setInvitationsLoading(true);
        setInvitationsError(null);
        try {
            const res = await fetch("/api/invitations");
            const json = await res.json();
            if (!res.ok || !json.success) {
                setInvitationsError(json.error ?? "Failed to load invitations. Refresh the page to try again.");
                return;
            }
            setInvitations(json.data ?? []);
        } catch {
            setInvitationsError("Failed to load invitations. Refresh the page to try again.");
        } finally {
            setInvitationsLoading(false);
        }
    }, []);

    const fetchRoles = useCallback(async () => {
        try {
            const res = await fetch("/api/settings/roles");
            const json = await res.json();
            if (!res.ok || !json.success) return;
            const custom = (json.data?.custom ?? []) as { name: string; level: number }[];
            setCustomRoles(custom.map((r) => ({ name: r.name, level: r.level })));
        } catch {
            // Non-blocking — predefined roles still work
        }
    }, []);

    useEffect(() => {
        fetchMembers();
        fetchInvitations();
        fetchRoles();
    }, [fetchMembers, fetchInvitations, fetchRoles]);

    const handleInvite = async (email: string, role: string) => {
        const res = await fetch("/api/invitations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, role }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
            throw new Error(json.error ?? "Invitation failed.");
        }
        setDialogOpen(false);
        await Promise.all([fetchMembers(), fetchInvitations()]);
    };

    const handleResend = async (id: string) => {
        const res = await fetch(`/api/invitations/${id}/resend`, { method: "POST" });
        const json = await res.json();
        if (!res.ok || !json.success) {
            throw new Error(json.error ?? "Resend failed.");
        }
        await fetchInvitations();
    };

    const handleRevoke = async (id: string) => {
        // Optimistic removal
        setInvitations((prev) => prev.filter((inv) => inv.id !== id));
        try {
            const res = await fetch(`/api/invitations/${id}/revoke`, { method: "POST" });
            const json = await res.json();
            if (!res.ok || !json.success) {
                // Restore on error
                await fetchInvitations();
            }
        } catch {
            await fetchInvitations();
        }
    };

    // Derive available roles based on current user's role level
    const sessionRole = (session?.user as { role?: string } | undefined)?.role ?? "Viewer";
    const userLevel = ROLE_HIERARCHY[sessionRole] ?? 1;
    const predefinedFiltered = ALL_ROLES.filter((r) => (ROLE_HIERARCHY[r] ?? 0) <= userLevel);
    const customFiltered = customRoles.filter((r) => r.level <= userLevel).map((r) => r.name);
    const availableRoles = [...predefinedFiltered, ...customFiltered];

    return (
        <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 bg-background">
            <div className="flex items-center justify-between">
                <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                        <Users className="h-6 w-6" />
                        <h2 className="text-3xl font-semibold tracking-tight">Members</h2>
                    </div>
                    <p className="text-muted-foreground">
                        Manage your organization&apos;s team members and pending invitations.
                    </p>
                </div>
                <Button onClick={() => setDialogOpen(true)}>Invite Member</Button>
            </div>

            <section className="space-y-4">
                <h3 className="text-xl font-semibold">Team Members</h3>
                <MembersTable
                    members={members}
                    loading={membersLoading}
                    error={membersError}
                />
            </section>

            <section className="mt-12 space-y-4">
                <h3 className="text-xl font-semibold">Pending Invitations</h3>
                <InvitationsTable
                    invitations={invitations}
                    loading={invitationsLoading}
                    error={invitationsError}
                    onResend={handleResend}
                    onRevoke={handleRevoke}
                />
            </section>

            <InviteMemberDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                onSubmit={handleInvite}
                availableRoles={availableRoles}
            />
        </div>
    );
}
