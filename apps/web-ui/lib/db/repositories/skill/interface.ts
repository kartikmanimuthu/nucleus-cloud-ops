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

export interface ISkillRepository {
    listByTenant(tenantId: string, opts?: { includeDisabled?: boolean }): Promise<SkillRecord[]>;
    getBySlug(tenantId: string, slug: string): Promise<SkillRecord | null>;
    getById(tenantId: string, id: string): Promise<SkillRecord | null>;
    create(tenantId: string, input: SkillCreateInput): Promise<SkillRecord>;
    update(tenantId: string, id: string, input: SkillUpdateInput): Promise<SkillRecord>;
    remove(tenantId: string, id: string): Promise<void>;
}
