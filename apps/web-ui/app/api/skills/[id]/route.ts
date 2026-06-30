/**
 * GET    /api/skills/[id]   — fetch a single skill by DB id or slug
 * PATCH  /api/skills/[id]   — update a skill
 * DELETE /api/skills/[id]   — remove a skill
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { getSkillRepository } from '@/lib/db/repository-factory';
import { slugify } from '@/lib/skill-service';
import { AuditService } from '@/lib/audit-service';
import type { SkillRecord, SkillUpdateInput } from '@/lib/db/repositories/skill/interface';

function toDTO(s: SkillRecord) {
    return {
        id: s.slug,
        name: s.name,
        description: s.description,
        tier: s.tier,
        source: s.source,
        isEnabled: s.isEnabled,
        createdBy: s.createdBy,
        content: s.content,
        updatedAt: s.updatedAt,
    };
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const tenantId = await getSessionTenantId();
        const skill = await getSkillRepository().getById(tenantId, id);
        if (!skill) {
            return NextResponse.json({ success: false, error: 'Skill not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true, data: toDTO(skill) });
    } catch (error) {
        console.error('[SkillsAPI] GET [id] error:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch skill' },
            { status: 500 }
        );
    }
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const authError = await authorize('update', 'Skill');
    if (authError) return authError;
    try {
        const { id } = await params;
        const tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        const body = await request.json();
        const updates: SkillUpdateInput = {};
        for (const k of ['name', 'description', 'tier', 'content', 'isEnabled'] as const) {
            if (body[k] !== undefined) (updates as Record<string, unknown>)[k] = body[k];
        }
        if (body.slug !== undefined) updates.slug = slugify(body.slug);
        const updated = await getSkillRepository().update(tenantId, id, updates);
        AuditService.logUserAction({
            action: 'update',
            resourceType: 'Skill',
            resourceId: id,
            resourceName: updated.name,
            user: session?.user?.email || 'api-user',
            userType: 'user',
            status: 'success',
            details: `Skill "${updated.name}" updated`,
            tenantId,
            severity: 'info',
            eventType: 'skill.update',
            apiRoute: 'PATCH /api/skills/[id]',
            httpMethod: 'PATCH',
        }).catch(() => {});
        return NextResponse.json({ success: true, data: toDTO(updated) });
    } catch (error) {
        console.error('[SkillsAPI] PATCH [id] error:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' },
            { status: 500 }
        );
    }
}

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const authError = await authorize('delete', 'Skill');
    if (authError) return authError;
    try {
        const { id } = await params;
        const tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        const existing = await getSkillRepository().getById(tenantId, id);
        if (!existing) {
            return NextResponse.json({ success: false, error: 'Skill not found' }, { status: 404 });
        }
        await getSkillRepository().remove(tenantId, id);
        AuditService.logUserAction({
            action: 'delete',
            resourceType: 'Skill',
            resourceId: id,
            resourceName: existing.name,
            user: session?.user?.email || 'api-user',
            userType: 'user',
            status: 'success',
            details: `Skill "${existing.name}" deleted`,
            tenantId,
            severity: 'medium',
            eventType: 'skill.delete',
            apiRoute: 'DELETE /api/skills/[id]',
            httpMethod: 'DELETE',
        }).catch(() => {});
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('[SkillsAPI] DELETE [id] error:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' },
            { status: 500 }
        );
    }
}
