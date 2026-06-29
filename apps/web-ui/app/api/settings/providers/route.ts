import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import {
    ProviderModelService,
    isProviderType,
    type ProviderModelEntry,
} from '@/lib/provider-model-service';
import { AuditService } from '@/lib/audit-service';

// Native Bedrock baseline (host/task-role credentials) — always available so the
// chat model picker works even with zero tenant-configured providers.
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
        const records = await ProviderModelService.listAllProviders(tenantId);
        const providers = records.map((r) => ProviderModelService.toClientProvider(r as never));

        // Build the flat chat-picker list. Each model id is the composite
        // `{providerType}:{modelId}:{providerRecordId}` so model-resolver routes
        // it to the right transport (bedrock record / anthropic / openai-family).
        const configuredModels = providers
            .filter((p) => p.isEnabled)
            .flatMap((p) => {
                const providerType = p.provider || 'openai-compatible';
                const chatModels = (p.models ?? []).filter(
                    (m) => !m.capabilities || m.capabilities.includes('chat'),
                );
                return chatModels.map((m: ProviderModelEntry) => ({
                    id: `${providerType}:${m.id}:${p.id}`,
                    label: `${m.label} (${p.name})`,
                    provider: providerType,
                }));
            });

        return NextResponse.json({
            success: true,
            data: {
                providers,
                models: [...BEDROCK_MODELS, ...configuredModels],
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
        const session = await getAuthSession();
        const callerEmail = session?.user?.email ?? 'unknown';
        const body = await request.json();
        const {
            name,
            provider,
            region,
            credentials,
            baseUrl,
            chatModel,
            embeddingModel,
            embeddingDimensions,
            models,
            isDefault,
        } = body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return NextResponse.json({ success: false, error: 'Provider name is required' }, { status: 400 });
        }
        if (provider !== undefined && !isProviderType(provider)) {
            return NextResponse.json({ success: false, error: `Invalid provider type: ${provider}` }, { status: 400 });
        }
        if (!models || !Array.isArray(models) || models.length === 0) {
            return NextResponse.json({ success: false, error: 'At least one model is required' }, { status: 400 });
        }

        const created = await ProviderModelService.createProvider(tenantId, {
            name: name.trim(),
            provider: provider ?? undefined,
            region: region || undefined,
            credentials: credentials || undefined,
            baseUrl: baseUrl?.trim() || undefined,
            chatModel: chatModel || undefined,
            embeddingModel: embeddingModel || undefined,
            embeddingDimensions: typeof embeddingDimensions === 'number' ? embeddingDimensions : undefined,
            models,
            isDefault: !!isDefault,
        });

        AuditService.logUserAction({
            eventType: 'integration.provider.created',
            severity: 'high',
            apiRoute: 'POST /api/settings/providers',
            httpMethod: 'POST',
            action: 'Created Provider',
            resourceType: 'integration',
            resourceId: created.id,
            resourceName: name.trim(),
            user: callerEmail,
            userType: 'user',
            status: 'success',
            details: `Created provider "${name.trim()}"`,
            metadata: { tenantId, provider: provider ?? 'openai-compatible', modelCount: models.length },
        }).catch(() => {});

        return NextResponse.json({ success: true, data: ProviderModelService.toClientProvider(created as never) }, { status: 201 });
    } catch (error) {
        console.error('API - Error creating provider:', error);

        AuditService.logUserAction({
            eventType: 'integration.provider.created',
            severity: 'high',
            apiRoute: 'POST /api/settings/providers',
            httpMethod: 'POST',
            action: 'Created Provider',
            resourceType: 'integration',
            resourceId: 'unknown',
            resourceName: '',
            user: 'unknown',
            userType: 'user',
            status: 'error',
            details: `Failed to create provider: ${error instanceof Error ? error.message : 'Unknown error'}`,
            metadata: {},
        }).catch(() => {});

        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create provider' },
            { status: 500 },
        );
    }
}
