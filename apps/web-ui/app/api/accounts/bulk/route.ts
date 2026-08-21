import { NextRequest, NextResponse } from "next/server";
import { AccountService } from "@/lib/account-service";
import { authorize } from "@/lib/rbac/authorize";
import { getAuthSession, getSessionTenantId } from "@/lib/auth-session";
import type { BulkActionResult, BulkItemResult } from "@/lib/bulk-actions/types";
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    POST: { action: 'create', subject: 'Account' },
};

type AccountBulkAction = "activate" | "deactivate" | "validate";

const ACTION_PERMISSION: Record<AccountBulkAction, { action: string; subject: string }> = {
    activate: { action: "update", subject: "Account" },
    deactivate: { action: "update", subject: "Account" },
    validate: { action: "validate", subject: "Account" },
};

// POST /api/accounts/bulk - run one action across many accounts (partial-success).
export async function POST(request: NextRequest) {
    let action: AccountBulkAction;
    let accountIds: string[];

    try {
        const body = await request.json();
        action = body.action;
        accountIds = body.accountIds;
    } catch {
        return NextResponse.json(
            { success: false, error: "Invalid JSON body" },
            { status: 400 }
        );
    }

    if (!action || !ACTION_PERMISSION[action]) {
        return NextResponse.json(
            { success: false, error: `Unsupported action: ${action}` },
            { status: 400 }
        );
    }
    if (!Array.isArray(accountIds) || accountIds.length === 0) {
        return NextResponse.json(
            { success: false, error: "accountIds must be a non-empty array" },
            { status: 400 }
        );
    }

    const { action: rbacAction, subject } = ACTION_PERMISSION[action];
    const authError = await authorize(rbacAction, subject);
    if (authError) return authError;

    let tenantId: string;
    try {
        tenantId = await getSessionTenantId();
    } catch {
        return NextResponse.json(
            { success: false, error: "Unauthorized" },
            { status: 401 }
        );
    }

    const session = await getAuthSession();
    const updatedBy = session?.user?.email || "api-user";

    const results: BulkItemResult[] = await Promise.all(
        accountIds.map(async (id): Promise<BulkItemResult> => {
            try {
                switch (action) {
                    case "activate":
                        await AccountService.updateAccount(id, { active: true, updatedBy }, tenantId);
                        break;
                    case "deactivate":
                        await AccountService.updateAccount(id, { active: false, updatedBy }, tenantId);
                        break;
                    case "validate":
                        await AccountService.validateAccount(id, tenantId);
                        break;
                }
                return { id, status: "success" };
            } catch (error) {
                console.error(`API - Bulk ${action} failed for account ${id}:`, error);
                return {
                    id,
                    status: "error",
                    error: error instanceof Error ? error.message : "Unknown error",
                };
            }
        })
    );

    const succeeded = results.filter((r) => r.status === "success").length;
    const data: BulkActionResult = {
        total: results.length,
        succeeded,
        failed: results.length - succeeded,
        results,
    };

    return NextResponse.json({ success: true, data });
}
