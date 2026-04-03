/**
 * InvitationService — manages the full invitation lifecycle.
 *
 * Flow for new users (D-04): AdminCreateUser → Cognito sends temp password email → user logs in
 * Flow for existing users (D-07/D-08): auto-join → UserTenantRole created immediately
 * Revocation (D-12): AdminDisableUser + mark invitation revoked
 * First login acceptance (D-14): acceptPendingInvitation called from session callback
 */

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { getCognitoClient, COGNITO_USER_POOL_ID } from "@/lib/cognito-client";
import {
    AdminCreateUserCommand,
    AdminDisableUserCommand,
    AdminEnableUserCommand,
    AdminSetUserPasswordCommand,
    MessageActionType,
} from "@aws-sdk/client-cognito-identity-provider";
import { getPrismaClient, getTenantClient } from "@/lib/db/pg-config";

export class InvitationService {
    /**
     * Create invitation. Per D-04: AdminCreateUser for new Cognito users.
     * Per D-07/D-08: existing users auto-joined (UserTenantRole created immediately).
     *
     * @returns { invitation, autoJoined: boolean }
     */
    static async createInvitation(
        tenantId: string,
        email: string,
        role: string,
        invitedBy: string
    ) {
        const prisma = getTenantClient(tenantId);
        const globalPrisma = getPrismaClient();

        // Check for duplicate pending invitation
        const existingInvitation = await prisma.invitation.findFirst({
            where: { email, status: "pending" },
        });
        if (existingInvitation) {
            throw new Error("An invitation is already pending for this email");
        }

        // Check if user is already a member
        const existingMember = await globalPrisma.userTenantRole.findFirst({
            where: { tenantId, email },
        });
        if (existingMember) {
            throw new Error("This user is already a member of your organization");
        }

        // Check if user exists in AuthUser table (D-08 auto-join detection)
        const existingUser = await globalPrisma.authUser.findUnique({
            where: { email },
        });

        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        if (existingUser) {
            // D-08: existing user — auto-join path
            await globalPrisma.userTenantRole.create({
                data: {
                    userId: existingUser.id,
                    tenantId,
                    email,
                    role,
                    assignedAt: new Date(),
                    assignedBy: invitedBy,
                },
            });

            const invitation = await prisma.invitation.create({
                data: {
                    email,
                    role,
                    invitedBy,
                    status: "accepted",
                    expiresAt,
                },
            });

            return { invitation, autoJoined: true };
        }

        // D-04: new user — create AuthUser with hashed temp password, then call Cognito.
        // AuthUser must exist before Cognito call so CredentialsProvider can find the user on login.
        // Temp password satisfies Cognito default policy: upper + lower + digit + special.
        const base = crypto.randomBytes(9).toString("base64url"); // ~12 URL-safe chars
        const tempPassword = base + "A1!"; // guarantee uppercase, digit, special char
        const passwordHash = await bcrypt.hash(tempPassword, 12);

        // Upsert AuthUser — may already exist if a previous invite attempt partially succeeded
        const existingAuthUser = await globalPrisma.authUser.findUnique({ where: { email } });
        if (existingAuthUser) {
            await globalPrisma.authUser.update({
                where: { email },
                data: { passwordHash },
            });
        } else {
            await globalPrisma.authUser.create({
                data: { email, passwordHash },
            });
        }

        try {
            const cognitoClient = getCognitoClient();
            try {
                await cognitoClient.send(
                    new AdminCreateUserCommand({
                        UserPoolId: COGNITO_USER_POOL_ID,
                        Username: email,
                        TemporaryPassword: tempPassword,
                        UserAttributes: [
                            { Name: "email", Value: email },
                            { Name: "email_verified", Value: "true" },
                        ],
                        DesiredDeliveryMediums: ["EMAIL"],
                    })
                );
            } catch (cognitoErr: unknown) {
                // User already exists in Cognito (e.g. from a previous revoked invite).
                // Re-enable, set new temp password, and resend the welcome email.
                const errType = (cognitoErr as { __type?: string }).__type;
                if (errType === "UsernameExistsException") {
                    await cognitoClient.send(
                        new AdminEnableUserCommand({
                            UserPoolId: COGNITO_USER_POOL_ID,
                            Username: email,
                        })
                    );
                    await cognitoClient.send(
                        new AdminSetUserPasswordCommand({
                            UserPoolId: COGNITO_USER_POOL_ID,
                            Username: email,
                            Password: tempPassword,
                            Permanent: false,
                        })
                    );
                    await cognitoClient.send(
                        new AdminCreateUserCommand({
                            UserPoolId: COGNITO_USER_POOL_ID,
                            Username: email,
                            MessageAction: MessageActionType.RESEND,
                        })
                    );
                } else {
                    throw cognitoErr;
                }
            }
        } catch (err) {
            // Roll back AuthUser changes if Cognito call fails unrecoverably
            if (!existingAuthUser) {
                await globalPrisma.authUser.delete({ where: { email } }).catch(() => {});
            }
            throw err;
        }

        const invitation = await prisma.invitation.create({
            data: {
                email,
                role,
                invitedBy,
                status: "pending",
                expiresAt,
            },
        });

        return { invitation, autoJoined: false };
    }

    /**
     * List invitations for a tenant.
     * Marks expired invitations (expiresAt < now) as expired on read.
     */
    static async listInvitations(tenantId: string) {
        const prisma = getTenantClient(tenantId);
        const invitations = await prisma.invitation.findMany({
            orderBy: { createdAt: "desc" },
        });

        const now = new Date();
        const toExpire = invitations.filter(
            (inv) => inv.status === "pending" && inv.expiresAt < now
        );

        if (toExpire.length > 0) {
            await prisma.invitation.updateMany({
                where: {
                    id: { in: toExpire.map((inv) => inv.id) },
                    status: "pending",
                },
                data: { status: "expired" },
            });
            // Update in-memory list to reflect expired status
            for (const inv of invitations) {
                if (toExpire.some((e) => e.id === inv.id)) {
                    inv.status = "expired";
                }
            }
        }

        return invitations;
    }

    /**
     * Resend invitation. Per D-11: calls AdminCreateUser with RESEND MessageAction.
     * Resets expiresAt to 7 days from now.
     */
    static async resendInvitation(invitationId: string, tenantId: string) {
        const prisma = getTenantClient(tenantId);

        const invitation = await prisma.invitation.findFirst({
            where: { id: invitationId, status: "pending" },
        });
        if (!invitation) {
            throw new Error("Invitation not found or not in pending status");
        }

        await getCognitoClient().send(
            new AdminCreateUserCommand({
                UserPoolId: COGNITO_USER_POOL_ID,
                Username: invitation.email,
                MessageAction: MessageActionType.RESEND,
            })
        );

        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const updated = await prisma.invitation.update({
            where: { id: invitationId },
            data: { expiresAt },
        });

        return updated;
    }

    /**
     * Revoke invitation. Per D-12: AdminDisableUser if user hasn't set permanent password.
     * Marks invitation as revoked.
     */
    static async revokeInvitation(invitationId: string, tenantId: string) {
        const prisma = getTenantClient(tenantId);

        const invitation = await prisma.invitation.findFirst({
            where: { id: invitationId, status: "pending" },
        });
        if (!invitation) {
            throw new Error("Invitation not found or not in pending status");
        }

        // Try to disable the Cognito user — catch if user doesn't exist
        try {
            await getCognitoClient().send(
                new AdminDisableUserCommand({
                    UserPoolId: COGNITO_USER_POOL_ID,
                    Username: invitation.email,
                })
            );
        } catch (err: unknown) {
            // User may not exist in Cognito (e.g., already cleaned up) — log and continue
            console.warn(
                `InvitationService.revokeInvitation: AdminDisableUser failed for ${invitation.email}:`,
                err
            );
        }

        const updated = await prisma.invitation.update({
            where: { id: invitationId },
            data: { status: "revoked" },
        });

        return updated;
    }

    /**
     * Accept pending invitations for a user on first login. Per D-14.
     * Creates UserTenantRole if not exists, marks invitation as accepted.
     * Called from auth session callback in auth-options.ts.
     */
    static async acceptPendingInvitation(userId: string, email: string) {
        const globalPrisma = getPrismaClient();

        const pendingInvitations = await globalPrisma.invitation.findMany({
            where: { email, status: "pending" },
        });

        for (const invitation of pendingInvitations) {
            try {
                // Check if UserTenantRole already exists
                const existingRole = await globalPrisma.userTenantRole.findFirst({
                    where: { userId, tenantId: invitation.tenantId },
                });

                if (!existingRole) {
                    await globalPrisma.userTenantRole.create({
                        data: {
                            userId,
                            tenantId: invitation.tenantId,
                            email,
                            role: invitation.role,
                            assignedAt: new Date(),
                            assignedBy: invitation.invitedBy,
                        },
                    });
                }

                await globalPrisma.invitation.update({
                    where: { id: invitation.id },
                    data: { status: "accepted" },
                });
            } catch (err) {
                console.error(
                    `InvitationService.acceptPendingInvitation: failed for invitation ${invitation.id}:`,
                    err
                );
            }
        }
    }
}
