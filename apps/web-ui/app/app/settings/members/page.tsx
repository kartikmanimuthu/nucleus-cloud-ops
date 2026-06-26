"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Users } from "lucide-react";
import { useSession } from "next-auth/react";
import { MembersTable } from "@/components/settings/members-table";
import { InvitationsTable } from "@/components/settings/invitations-table";
import { InviteMemberDialog } from "@/components/settings/invite-member-dialog";
import {
    useMembers,
    useInvitations,
    useInviteMember,
    useResendInvitation,
    useChangeMemberRole,
    useRevokeInvitation,
} from "@/lib/queries/members";
import { useRoles } from "@/lib/queries/roles";

const ROLE_HIERARCHY: Record<string, number> = {
    Owner: 4,
    Admin: 3,
    Member: 2,
    Viewer: 1,
};

export default function MembersPage() {
    const { data: session } = useSession();

    const membersQuery = useMembers();
    const invitationsQuery = useInvitations();
    const rolesQuery = useRoles();

    const inviteMember = useInviteMember();
    const resendInvitation = useResendInvitation();
    const changeMemberRole = useChangeMemberRole();
    const revokeInvitation = useRevokeInvitation();

    const members = membersQuery.data ?? [];
    const membersLoading = membersQuery.isLoading;
    const membersError = membersQuery.error
        ? membersQuery.error instanceof Error
            ? membersQuery.error.message
            : "Failed to load members. Refresh the page to try again."
        : null;

    const invitations = invitationsQuery.data ?? [];
    const invitationsLoading = invitationsQuery.isLoading;
    const invitationsError = invitationsQuery.error
        ? invitationsQuery.error instanceof Error
            ? invitationsQuery.error.message
            : "Failed to load invitations. Refresh the page to try again."
        : null;

    const predefinedRoles = rolesQuery.data?.predefined ?? [];
    const customRoles = rolesQuery.data?.custom ?? [];

    const [dialogOpen, setDialogOpen] = useState(false);

    const handleInvite = async (email: string, role: string) => {
        // mutateAsync throws on failure so the dialog can surface the error.
        await inviteMember.mutateAsync({ email, role });
        setDialogOpen(false);
    };

    const handleResend = async (id: string) => {
        await resendInvitation.mutateAsync(id);
    };

    const handleRoleChange = async (memberId: string, role: string) => {
        await changeMemberRole.mutateAsync({ memberId, role });
    };

    const handleRevoke = async (id: string) => {
        // Optimistic removal + rollback handled inside the mutation's onMutate/onError.
        try {
            await revokeInvitation.mutateAsync(id);
        } catch {
            // error already surfaced via rollback; nothing else to do
        }
    };

    // Derive available roles based on current user's role level
    const sessionRole = (session?.user as { role?: string } | undefined)?.role ?? "Viewer";
    const currentUserId = (session?.user as { id?: string } | undefined)?.id ?? "";
    const userLevel = ROLE_HIERARCHY[sessionRole] ?? 1;
    const predefinedFiltered = predefinedRoles.filter((r) => r.level <= userLevel).map((r) => r.name);
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
                    currentUserId={currentUserId}
                    availableRoles={availableRoles}
                    onRoleChange={handleRoleChange}
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
