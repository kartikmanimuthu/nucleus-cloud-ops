import { TenantConfigService } from "@/lib/tenant-config-service";
import { getPrismaClient } from "@/lib/db/pg-config";

export interface OrgSettings {
    timezone: string;
    notifications: {
        scheduleExecutions: boolean;
        memberInvites: boolean;
        systemAlerts: boolean;
    };
}

export interface OrgLogo {
    key: string;
    url: string;
}

const DEFAULT_ORG_SETTINGS: OrgSettings = {
    timezone: "UTC",
    notifications: {
        scheduleExecutions: true,
        memberInvites: true,
        systemAlerts: true,
    },
};

export class TenantSettingsService {
    /**
     * Get org settings (name from Tenant, timezone+notifications from TenantConfig).
     */
    static async getSettings(tenantId: string): Promise<{
        name: string;
        slug: string | null;
        timezone: string;
        notifications: OrgSettings["notifications"];
    }> {
        const prisma = getPrismaClient();
        const tenant = await prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { name: true, slug: true },
        });

        const settings = await TenantConfigService.getConfig<OrgSettings>(
            "org_settings",
            tenantId
        );

        return {
            name: tenant?.name ?? "",
            slug: tenant?.slug ?? null,
            timezone: settings?.timezone ?? DEFAULT_ORG_SETTINGS.timezone,
            notifications: settings?.notifications ?? DEFAULT_ORG_SETTINGS.notifications,
        };
    }

    /**
     * Update org settings.
     * Per D-11: name updates Tenant.name directly; timezone+notifications go to TenantConfig.
     */
    static async updateSettings(
        tenantId: string,
        data: { name: string; timezone: string; notifications: OrgSettings["notifications"] },
        updatedBy: string
    ): Promise<void> {
        const prisma = getPrismaClient();

        // Update Tenant.name directly (per D-11)
        await prisma.tenant.update({
            where: { id: tenantId },
            data: { name: data.name },
        });

        // Update TenantConfig for timezone + notifications (per D-10)
        await TenantConfigService.saveConfig<OrgSettings>(
            "org_settings",
            { timezone: data.timezone, notifications: data.notifications },
            tenantId,
            updatedBy
        );
    }

    /**
     * Get org logo URL from TenantConfig.
     */
    static async getLogo(tenantId: string): Promise<OrgLogo | null> {
        return TenantConfigService.getConfig<OrgLogo>("org_logo", tenantId);
    }

    /**
     * Save org logo S3 key + URL in TenantConfig.
     */
    static async saveLogo(
        tenantId: string,
        logo: OrgLogo,
        updatedBy: string
    ): Promise<void> {
        await TenantConfigService.saveConfig<OrgLogo>(
            "org_logo",
            logo,
            tenantId,
            updatedBy
        );
    }
}
