import "next-auth";

declare module "next-auth" {
    interface Session {
        user: {
            id: string;
            email: string;
            tenantId: string | null;
            /** Display name of the active tenant. Present regardless of Settings
             *  permissions so the sidebar can show which org you are in. */
            tenantName?: string | null;
            role: string | null;
            isSuperAdmin: boolean;
            /** Cognito group claims — read by components/settings/profile-form.tsx. */
            groups?: string[];
        };
    }

    interface User {
        id: string;
        email: string;
        passwordHash?: string | null;
        isSuperAdmin: boolean;
        failedAttempts: number;
        lockedUntil: Date | null;
        activeTenantId?: string | null;
    }
}

declare module "next-auth/adapters" {
    interface AdapterUser {
        id: string;
        email: string;
        passwordHash?: string | null;
        isSuperAdmin: boolean;
        failedAttempts: number;
        lockedUntil: Date | null;
        activeTenantId?: string | null;
    }
}

declare module "next-auth/jwt" {
    interface JWT {
        tenantId?: string | null;
        tenantName?: string | null;
        role?: string | null;
        isSuperAdmin?: boolean;
    }
}
