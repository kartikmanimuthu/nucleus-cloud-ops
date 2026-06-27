import "@/lib/auth-types";
import { NextAuthOptions } from "next-auth";
import CognitoProvider from "next-auth/providers/cognito";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { getPrismaClient } from "@/lib/db/pg-config";
import { AuditService } from "@/lib/audit-service";
import { env } from "@/env";

const prisma = getPrismaClient();

// PrismaAdapter expects model names: user, account, session, verificationToken
// Our schema uses AuthUser/AuthAccount/AuthSession to avoid collision with existing Account model
// Create a proxy that maps adapter model names to our custom model names
const prismaForAuth = {
    user: prisma.authUser,
    account: prisma.authAccount,
    session: prisma.authSession,
    verificationToken: prisma.verificationToken,
};

export const authOptions: NextAuthOptions = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: PrismaAdapter(prismaForAuth as any),
    session: {
        strategy: "jwt",
        maxAge: 24 * 60 * 60, // 24 hours per D-06
    },
    providers: [
        CredentialsProvider({
            id: "credentials",
            name: "Credentials",
            credentials: {
                email: { label: "Email", type: "email" },
                password: { label: "Password", type: "password" },
            },
            async authorize(credentials) {
                if (!credentials?.email || !credentials?.password) {
                    return null;
                }

                const email = credentials.email as string;
                const password = credentials.password as string;

                const user = await prisma.authUser.findUnique({ where: { email } });

                if (!user) return null;
                // Cognito-only user (no password hash) — surface a helpful message
                if (!user.passwordHash) {
                    throw new Error("This account uses SSO. Please sign in with the SSO tab.");
                }

                // Check account lockout (D-11: 15 min lockout after 5 failed attempts)
                if (user.lockedUntil && user.lockedUntil > new Date()) {
                    const minutesLeft = Math.ceil(
                        (user.lockedUntil.getTime() - Date.now()) / (60 * 1000)
                    );
                    throw new Error(
                        `Account locked. Try again in ${minutesLeft} minute${minutesLeft !== 1 ? "s" : ""}.`
                    );
                }

                const passwordValid = await bcrypt.compare(password, user.passwordHash);

                if (!passwordValid) {
                    // Increment failed attempts; lock if >= 5
                    const newFailedAttempts = user.failedAttempts + 1;
                    const lockedUntil =
                        newFailedAttempts >= 5
                            ? new Date(Date.now() + 15 * 60 * 1000)
                            : null;

                    await prisma.authUser.update({
                        where: { id: user.id },
                        data: {
                            failedAttempts: newFailedAttempts,
                            ...(lockedUntil ? { lockedUntil } : {}),
                        },
                    });

                    // Audit: failed login attempt
                    const utr = await prisma.userTenantRole.findFirst({ where: { userId: user.id } });
                    AuditService.createAuditLog({
                        tenantId: utr?.tenantId ?? 'unknown',
                        eventType: 'auth.session.login_failed',
                        action: 'Login Failed',
                        user: email,
                        userType: 'user',
                        status: 'error',
                        severity: lockedUntil ? 'critical' : 'high',
                        details: lockedUntil
                            ? `Account locked after ${newFailedAttempts} failed attempts for ${email}`
                            : `Failed login attempt ${newFailedAttempts} for ${email}`,
                        source: 'platform',
                        metadata: { failedAttempts: newFailedAttempts, locked: !!lockedUntil },
                    }).catch(() => {});

                    return null;
                }

                // Successful login — reset lockout state
                await prisma.authUser.update({
                    where: { id: user.id },
                    data: { failedAttempts: 0, lockedUntil: null },
                });

                return {
                    id: user.id,
                    email: user.email,
                    isSuperAdmin: user.isSuperAdmin,
                    failedAttempts: 0,
                    lockedUntil: null,
                };
            },
        }),
        CognitoProvider({
            clientId: env.COGNITO_APP_CLIENT_ID,
            clientSecret: env.COGNITO_APP_CLIENT_SECRET,
            issuer: env.COGNITO_ISSUER as string,
            allowDangerousEmailAccountLinking: true,
        }),
    ],
    pages: {
        signIn: "/login",
        error: "/login",
    },
    callbacks: {
        async jwt({ token, user, trigger }) {
            // On initial sign-in (user is present) OR session update (e.g. after org creation),
            // re-query tenant info from DB.
            if (user || trigger === "update") {
                const userId = user?.id ?? (token.sub as string);
                // Per D-07: Prefer activeTenantId if set, otherwise fall back to findFirst
                // On trigger==="update", user is undefined — re-fetch activeTenantId from DB
                let activeTenantId = (user as any)?.activeTenantId ?? null;
                if (!activeTenantId && trigger === "update") {
                    const dbUser = await prisma.authUser.findUnique({
                        where: { id: userId },
                        select: { activeTenantId: true },
                    });
                    activeTenantId = dbUser?.activeTenantId ?? null;
                }
                let utr;
                if (activeTenantId) {
                    utr = await prisma.userTenantRole.findFirst({
                        where: { userId, tenantId: activeTenantId },
                    });
                }
                if (!utr) {
                    utr = await prisma.userTenantRole.findFirst({
                        where: { userId },
                        orderBy: { assignedAt: 'desc' }, // most recent tenant membership
                    });
                }
                // D-14: Accept pending invitations on first login with no tenant (sign-in only)
                if (!utr && user) {
                    try {
                        const { InvitationService } = await import("@/lib/invitation-service");
                        await InvitationService.acceptPendingInvitation(userId, user.email ?? "");
                        utr = await prisma.userTenantRole.findFirst({
                            where: { userId },
                        });
                    } catch (err) {
                        console.error("jwt callback: acceptPendingInvitation failed:", err);
                    }
                }
                token.tenantId = utr?.tenantId ?? null;
                token.role = utr?.role ?? null;
                if (user) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    token.isSuperAdmin = (user as any).isSuperAdmin ?? false;
                    token.email = user.email;
                }
            }
            return token;
        },
        async session({ session, token }) {
            // JWT strategy provides `token` (not `user`)
            session.user = {
                id: token.sub as string,
                email: (token.email as string) ?? "",
                tenantId: (token.tenantId as string | null) ?? null,
                role: (token.role as string | null) ?? null,
                isSuperAdmin: (token.isSuperAdmin as boolean) ?? false,
            };
            return session;
        },
        async redirect({ url, baseUrl }) {
            // Allows relative callback URLs
            if (url.startsWith("/")) return `${baseUrl}${url}`;
            // Allows callback URLs on the same origin
            else if (new URL(url).origin === baseUrl) return url;
            return baseUrl;
        },
    },
    secret: env.NEXTAUTH_SECRET,
    events: {
        async signIn({ user, account }) {
            const utr = await prisma.userTenantRole.findFirst({ where: { userId: user.id } });
            AuditService.createAuditLog({
                tenantId: utr?.tenantId ?? 'unknown',
                eventType: 'auth.session.login',
                action: 'User Login',
                user: user.email ?? user.id,
                userType: 'user',
                status: 'success',
                severity: 'low',
                details: `User ${user.email} logged in via ${account?.provider ?? 'credentials'}`,
                source: 'platform',
                metadata: { provider: account?.provider ?? 'credentials', userId: user.id },
            }).catch(() => {});
        },
        async signOut({ token }) {
            const userId = token?.sub as string | undefined;
            const email = token?.email as string | undefined;
            const tenantId = token?.tenantId as string | undefined;
            AuditService.createAuditLog({
                tenantId: tenantId ?? 'unknown',
                eventType: 'auth.session.logout',
                action: 'User Logout',
                user: email ?? userId ?? 'unknown',
                userType: 'user',
                status: 'success',
                severity: 'low',
                details: `User ${email ?? userId} logged out`,
                source: 'platform',
            }).catch(() => {});
        },
    },
};
