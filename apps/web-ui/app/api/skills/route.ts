/**
 * GET  /api/skills       — list skills for tenant (enabled only by default; ?all includes disabled)
 * POST /api/skills       — create a new skill
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { getSkillRepository } from '@/lib/db/repository-factory';
import { slugify } from '@/lib/skill-service';
import { AuditService } from '@/lib/audit-service';
import type { SkillRecord } from '@/lib/db/repositories/skill/interface';

function toDTO(s: SkillRecord) {
    return {
        id: s.slug,
        name: s.name,
        description: s.description,
        tier: s.tier,
        source: s.source,
        isEnabled: s.isEnabled,
        createdBy: s.createdBy,
        updatedAt: s.updatedAt,
    };
}

export async function GET(request: NextRequest) {
    try {
        const tenantId = await getSessionTenantId();
        const includeDisabled = new URL(request.url).searchParams.has('all');
        const skills = await getSkillRepository().listByTenant(tenantId, { includeDisabled });
        return NextResponse.json({ success: true, skills: skills.map(toDTO) });
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('Unauthenticated')) {
            return NextResponse.json({ success: false, error: 'Unauthenticated' }, { status: 401 });
        }
        console.error('[SkillsAPI] GET error:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to load skills' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    const authError = await authorize('create', 'Skill');
    if (authError) return authError;
    try {
        const tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        const body = await request.json();
        const { name, description, tier, content, isEnabled = true, source = 'user', sourceRunId = null } = body;
        if (!name || !description || !tier || !content) {
            return NextResponse.json(
                { success: false, error: 'Missing required fields: name, description, tier, content' },
                { status: 400 }
            );
        }
        const slug = body.slug && String(body.slug).trim() ? slugify(body.slug) : slugify(name);
        if (await getSkillRepository().getBySlug(tenantId, slug)) {
            return NextResponse.json(
                { success: false, error: `A skill with slug "${slug}" already exists` },
                { status: 409 }
            );
        }
        let created: SkillRecord;
        try {
            created = await getSkillRepository().create(tenantId, {
                slug,
                name,
                description,
                tier,
                content,
                source,
                isEnabled,
                createdBy: session?.user?.id ?? null,
                sourceRunId,
            });
        } catch (err) {
            if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
                return NextResponse.json(
                    { success: false, error: `A skill with slug "${slug}" already exists` },
                    { status: 409 }
                );
            }
            throw err;
        }
        AuditService.logUserAction({
            action: 'create',
            resourceType: 'Skill',
            resourceId: created.id,
            resourceName: created.name,
            user: session?.user?.email || 'api-user',
            userType: 'user',
            status: 'success',
            details: `Skill "${created.name}" created`,
            tenantId,
            severity: 'info',
            eventType: 'skill.create',
            apiRoute: 'POST /api/skills',
            httpMethod: 'POST',
        }).catch(() => {});
        return NextResponse.json({ success: true, data: toDTO(created) }, { status: 201 });
    } catch (error) {
        console.error('[SkillsAPI] POST error:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create skill' },
            { status: 500 }
        );
    }
}
