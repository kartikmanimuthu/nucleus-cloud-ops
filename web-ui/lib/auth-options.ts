import "@/lib/auth-types";
import { NextAuthOptions } from "next-auth";
import CognitoProvider from "next-auth/providers/cognito";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { getPrismaClient } from "@/lib/db/pg-config";

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
            clientId: process.env.COGNITO_APP_CLIENT_ID as string,
            clientSecret: process.env.COGNITO_APP_CLIENT_SECRET as string,
            issuer: process.env.COGNITO_ISSUER as string,
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
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const activeTenantId = (user as any)?.activeTenantId ?? null;
                let utr;
                if (activeTenantId) {
                    utr = await prisma.userTenantRole.findFirst({
                        where: { userId, tenantId: activeTenantId },
                    });
                }
                if (!utr) {
                    utr = await prisma.userTenantRole.findFirst({
                        where: { userId },
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
    secret: process.env.NEXTAUTH_SECRET,
};
