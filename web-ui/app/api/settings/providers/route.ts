import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ProviderModelService } from '@/lib/provider-model-service';

const BEDROCK_MODELS = [
    { id: 'bedrock:global.anthropic.claude-sonnet-4-6', label: 'Claude 4.6 Sonnet', provider: 'bedrock' },
    { id: 'bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude 4.5 Sonnet', provider: 'bedrock' },
    { id: 'bedrock:global.amazon.nova-2-lite-v1:0', label: 'Nova 2 Lite', provider: 'bedrock' },
    { id: 'bedrock:global.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude 4.5 Haiku', provider: 'bedrock' },
    { id: 'bedrock:global.anthropic.claude-opus-4-5-20251101-v1:0', label: 'Claude 4.5 Opus', provider: 'bedrock' },
    { id: 'bedrock:global.anthropic.claude-opus-4-6-v1', label: 'Claude 4.6 Opus', provider: 'bedrock' },
];

export async function GET(_request: NextRequest) {
    console.log('API - GET /api/settings/providers - Fetching providers');
    const authError = await authorize('read', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const providers = await ProviderModelService.listAllProviders(tenantId);

        const selfHostedModels = providers
            .filter(p => p.isEnabled)
            .flatMap(p => {
                const models = p.models as Array<{ id: string; label: string; maxTokens?: number }>;
                return models.map(m => ({
                    id: `openai-compatible:${m.id}:${p.id}`,
                    label: `${m.label} (${p.name})`,
                    provider: 'openai-compatible' as const,
                }));
            });

        return NextResponse.json({
            success: true,
            data: {
                providers,
                models: [...BEDROCK_MODELS, ...selfHostedModels],
            },
        });
    } catch (error) {
        console.error('API - Error fetching providers:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch providers' },
            { status: 500 },
        );
    }
}

export async function POST(request: NextRequest) {
    console.log('API - POST /api/settings/providers - Creating provider');
    const authError = await authorize('update', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const body = await request.json();
        const { name, baseUrl, apiKey, models } = body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return NextResponse.json({ success: false, error: 'Provider name is required' }, { status: 400 });
        }
        if (!baseUrl || typeof baseUrl !== 'string') {
            return NextResponse.json({ success: false, error: 'Base URL is required' }, { status: 400 });
        }
        if (!models || !Array.isArray(models) || models.length === 0) {
            return NextResponse.json({ success: false, error: 'At least one model is required' }, { status: 400 });
        }

        const provider = await ProviderModelService.createProvider(tenantId, {
            name: name.trim(),
            baseUrl: baseUrl.trim(),
            apiKey: apiKey || undefined,
            models,
        });

        return NextResponse.json({ success: true, data: provider }, { status: 201 });
    } catch (error) {
        console.error('API - Error creating provider:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create provider' },
            { status: 500 },
        );
    }
}
