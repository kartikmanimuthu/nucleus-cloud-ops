import { andWhere, getTenantClient } from '@/lib/db/pg-config';
import type {
    ISkillRepository, SkillRecord, SkillCreateInput, SkillUpdateInput, SkillTier, SkillSource, SkillListOptions,
} from './interface';

type Row = {
    id: string; tenantId: string; slug: string; name: string; description: string;
    tier: string; content: string; source: string; isEnabled: boolean;
    createdBy: string | null; sourceRunId: string | null; createdAt: Date; updatedAt: Date;
};

function toRecord(r: Row): SkillRecord {
    return { ...r, tier: r.tier as SkillTier, source: r.source as SkillSource };
}

export class SkillPostgresRepository implements ISkillRepository {
    async listByTenant(tenantId: string, opts?: SkillListOptions): Promise<SkillRecord[]> {
        const where: Record<string, unknown> = { tenantId };
        if (!opts?.includeDisabled) where.isEnabled = true;
        // Gate 3: intersect the caller's readable rows.
        const scoped = andWhere(where, opts?.rowFilter);
        const rows = await getTenantClient(tenantId).skill.findMany({
            where: scoped, orderBy: { name: 'asc' },
        });
        return (rows as Row[]).map(toRecord);
    }

    async getBySlug(tenantId: string, slug: string): Promise<SkillRecord | null> {
        const row = await getTenantClient(tenantId).skill.findFirst({ where: { tenantId, slug } });
        return row ? toRecord(row as Row) : null;
    }

    async getById(tenantId: string, id: string): Promise<SkillRecord | null> {
        const row = await getTenantClient(tenantId).skill.findFirst({ where: { tenantId, id } });
        return row ? toRecord(row as Row) : null;
    }

    async create(tenantId: string, input: SkillCreateInput): Promise<SkillRecord> {
        const row = await getTenantClient(tenantId).skill.create({ data: { ...input, tenantId } });
        return toRecord(row as Row);
    }

    async update(tenantId: string, id: string, input: SkillUpdateInput): Promise<SkillRecord> {
        // updateMany keeps the tenant filter in the WHERE (update() targets unique id only).
        await getTenantClient(tenantId).skill.updateMany({ where: { tenantId, id }, data: input });
        const row = await getTenantClient(tenantId).skill.findFirst({ where: { tenantId, id } });
        if (!row) throw new Error(`Skill ${id} not found after update`);
        return toRecord(row as Row);
    }

    async remove(tenantId: string, id: string): Promise<void> {
        await getTenantClient(tenantId).skill.deleteMany({ where: { tenantId, id } });
    }
}
