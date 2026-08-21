import type { PrismaRowFilter } from '@/lib/db/pg-config';

export type SkillTier = 'read-only' | 'mutation' | 'approval-gated';
export type SkillSource = 'user' | 'system';

export interface SkillRecord {
    id: string;
    tenantId: string;
    slug: string;
    name: string;
    description: string;
    tier: SkillTier;
    content: string;
    source: SkillSource;
    isEnabled: boolean;
    createdBy: string | null;
    sourceRunId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface SkillCreateInput {
    slug: string;
    name: string;
    description: string;
    tier: SkillTier;
    content: string;
    source: SkillSource;
    isEnabled: boolean;
    createdBy: string | null;
    sourceRunId: string | null;
}

export type SkillUpdateInput = Partial<
    Pick<SkillRecord, 'name' | 'description' | 'tier' | 'content' | 'isEnabled' | 'slug'>
>;

export interface SkillListOptions {
    includeDisabled?: boolean;
    /**
     * Gate 3 (RBAC row filtering): a Prisma `where` fragment restricting the
     * result to the rows the caller may read. Built by
     * getReadRowFilter() in lib/rbac/row-filter.ts and INTERSECTED with the
     * query below via andWhere() — never merged over it.
     */
    rowFilter?: PrismaRowFilter | null;
}

export interface ISkillRepository {
    listByTenant(tenantId: string, opts?: SkillListOptions): Promise<SkillRecord[]>;
    getBySlug(tenantId: string, slug: string): Promise<SkillRecord | null>;
    getById(tenantId: string, id: string): Promise<SkillRecord | null>;
    create(tenantId: string, input: SkillCreateInput): Promise<SkillRecord>;
    update(tenantId: string, id: string, input: SkillUpdateInput): Promise<SkillRecord>;
    remove(tenantId: string, id: string): Promise<void>;
}
