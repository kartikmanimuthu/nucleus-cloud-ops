import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ProviderModelService } from '@/lib/provider-model-service';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`API - POST /api/settings/providers/${id}/test - Testing connectivity`);
    const authError = await authorize('update', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const provider = await ProviderModelService.getProvider(id, tenantId);
        if (!provider) {
            return NextResponse.json({ success: false, error: 'Provider not found' }, { status: 404 });
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (provider.apiKey) {
            headers['Authorization'] = `Bearer ${provider.apiKey}`;
        }

        const response = await fetch(`${provider.baseUrl}/models`, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
            return NextResponse.json({
                success: false,
                error: `Endpoint returned ${response.status}: ${response.statusText}`,
            }, { status: 502 });
        }

        const data = await response.json();
        const availableModels = data.data?.map((m: any) => ({ id: m.id, name: m.id })) ?? [];

        return NextResponse.json({
            success: true,
            data: { status: 'connected', availableModels },
        });
    } catch (error) {
        console.error('API - Error testing provider:', error);
        const message = error instanceof Error ? error.message : 'Connection failed';
        return NextResponse.json({ success: false, error: message }, { status: 502 });
    }
}
