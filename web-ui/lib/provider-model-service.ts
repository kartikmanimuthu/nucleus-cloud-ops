import { getTenantClient } from '@/lib/db/pg-config';

export interface ProviderModelInput {
    name: string;
    baseUrl: string;
    apiKey?: string;
    models: Array<{ id: string; label: string; maxTokens?: number }>;
}

export class ProviderModelService {
    static async listProviders(tenantId: string) {
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.findMany({
            where: { isEnabled: true },
            orderBy: { createdAt: 'asc' },
        });
    }

    static async listAllProviders(tenantId: string) {
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.findMany({ orderBy: { createdAt: 'asc' } });
    }

    static async getProvider(id: string, tenantId: string) {
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.findFirst({ where: { id } });
    }

    static async createProvider(tenantId: string, input: ProviderModelInput) {
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.create({
            data: {
                tenantId,
                name: input.name,
                provider: 'openai-compatible',
                baseUrl: input.baseUrl,
                apiKey: input.apiKey,
                models: input.models,
                isEnabled: true,
            },
        });
    }

    static async updateProvider(
        id: string,
        tenantId: string,
        input: Partial<ProviderModelInput> & { isEnabled?: boolean }
    ) {
        const existing = await this.getProvider(id, tenantId);
        if (!existing) throw new Error('Provider not found');
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.update({
            where: { id },
            data: {
                ...(input.name !== undefined && { name: input.name }),
                ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
                ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
                ...(input.models !== undefined && { models: input.models }),
                ...(input.isEnabled !== undefined && { isEnabled: input.isEnabled }),
            },
        });
    }

    static async deleteProvider(id: string, tenantId: string) {
        const existing = await this.getProvider(id, tenantId);
        if (!existing) throw new Error('Provider not found');
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.delete({ where: { id } });
    }
}
