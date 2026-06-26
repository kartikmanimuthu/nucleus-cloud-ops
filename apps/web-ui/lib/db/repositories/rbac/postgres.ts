/**
 * RbacPostgresRepository
 *
 * PostgreSQL implementation of IRbacRepository using Prisma ORM.
 * Reads/writes the `user_tenant_roles` table (defined in libs/prisma/schema.prisma).
 *
 * The UserTenantRole Prisma model uses @@unique([userId, tenantId]) which generates
 * the compound key name `userId_tenantId` for Prisma where clauses.
 *
 * Multi-tenant safety: every query is scoped by tenantId where relevant.
 */
import { getPrismaClient } from '@/lib/db/pg-config';
import type { TenantRole, UserTenantRole } from '@/lib/rbac/types';
import type { IRbacRepository } from './interface';

export class RbacPostgresRepository implements IRbacRepository {
    async getUserTenantRole(userId: string, tenantId: string): Promise<TenantRole | null> {
        try {
            const record = await getPrismaClient().userTenantRole.findUnique({
                where: {
                    userId_tenantId: { userId, tenantId },
                },
            });
            if (!record) return null;
            return record.role as TenantRole;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[RbacPostgresRepository] Error in getUserTenantRole:', error);
            throw new Error(`Failed to get user tenant role: ${msg}`);
        }
    }

    async getUserAllRoles(userId: string): Promise<UserTenantRole[]> {
        try {
            const records = await getPrismaClient().userTenantRole.findMany({
                where: { userId },
            });
            return records.map((r) => this.mapToUserTenantRole(r));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[RbacPostgresRepository] Error in getUserAllRoles:', error);
            throw new Error(`Failed to get user roles: ${msg}`);
        }
    }

    async assignUserRole(
        userId: string,
        email: string,
        tenantId: string,
        role: TenantRole,
        assignedBy: string
    ): Promise<void> {
        try {
            const customRole = await getPrismaClient().customRole.findFirst({
                where: { tenantId, name: role },
            });
            await getPrismaClient().userTenantRole.upsert({
                where: {
                    userId_tenantId: { userId, tenantId },
                },
                update: {
                    role,
                    roleId: customRole?.id ?? null,
                    email,
                    assignedBy,
                    assignedAt: new Date(),
                },
                create: {
                    userId,
                    email,
                    tenantId,
                    role,
                    roleId: customRole?.id ?? null,
                    assignedBy,
                },
            });
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[RbacPostgresRepository] Error in assignUserRole:', error);
            throw new Error(`Failed to assign user role: ${msg}`);
        }
    }

    async getTenantUsers(tenantId: string): Promise<UserTenantRole[]> {
        try {
            const records = await getPrismaClient().userTenantRole.findMany({
                where: { tenantId },
            });
            return records.map((r) => this.mapToUserTenantRole(r));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[RbacPostgresRepository] Error in getTenantUsers:', error);
            throw new Error(`Failed to get tenant users: ${msg}`);
        }
    }

    private mapToUserTenantRole(record: {
        userId: string;
        tenantId: string;
        email: string;
        role: string;
        assignedAt: Date;
        assignedBy: string;
    }): UserTenantRole {
        return {
            PK: `USER#${record.userId}`,
            SK: `TENANT#${record.tenantId}`,
            EntityType: 'UserTenantRole',
            userId: record.userId,
            tenantId: record.tenantId,
            email: record.email,
            role: record.role as TenantRole,
            assignedAt: record.assignedAt.toISOString(),
            assignedBy: record.assignedBy,
        };
    }
}
