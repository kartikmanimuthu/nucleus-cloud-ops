import { NextRequest, NextResponse } from "next/server";
import { getAuthSession, getSessionTenantId } from "@/lib/auth-session";
import { authorize } from "@/lib/rbac/authorize";
import { TenantSettingsService } from "@/lib/tenant-settings-service";
import { AuditService } from "@/lib/audit-service";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { env } from "@/env";

const ALLOWED_CONTENT_TYPES = ["image/png", "image/jpeg", "image/svg+xml"];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB per D-14

const presignRequestSchema = z.object({
    contentType: z.string().refine((ct) => ALLOWED_CONTENT_TYPES.includes(ct), {
        message: "Allowed formats: PNG, JPG, SVG",
    }),
    size: z.number().max(MAX_FILE_SIZE, "Max file size is 2MB"),
    ext: z.string().min(1),
});

const saveLogoSchema = z.object({
    key: z.string().min(1, "S3 key is required"),
});

/**
 * POST — Generate presigned PUT URL for logo upload.
 * Per D-12: client uploads directly to S3 via presigned URL.
 */
export async function POST(req: NextRequest) {
    if (!env.APP_BUCKET_NAME) {
        return NextResponse.json(
            { error: "Logo storage not configured (APP_BUCKET_NAME missing)" },
            { status: 500 }
        );
    }
    try {
        const authError = await authorize("update", "Tenant");
        if (authError) return authError;

        const tenantId = await getSessionTenantId();

        const body = await req.json();
        const parsed = presignRequestSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                { error: parsed.error.issues[0].message },
                { status: 400 }
            );
        }

        const { contentType, size, ext } = parsed.data;
        const s3Key = `assets/tenants/${tenantId}/logos/${Date.now()}.${ext}`;

        const s3 = new S3Client({ region: env.AWS_REGION });
        const command = new PutObjectCommand({
            Bucket: env.APP_BUCKET_NAME,
            Key: s3Key,
            ContentType: contentType,
            ContentLength: size,
        });
        const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

        // Build the public URL (CloudFront or direct S3)
        const publicUrl = env.ASSETS_CDN_URL
            ? `${env.ASSETS_CDN_URL}/${s3Key}`
            : `https://${env.APP_BUCKET_NAME}.s3.${env.AWS_REGION}.amazonaws.com/${s3Key}`;

        console.log(`API - POST /api/tenants/logo - Generated presigned URL for tenant ${tenantId}`);

        return NextResponse.json({
            success: true,
            url: presignedUrl,
            key: s3Key,
            publicUrl,
        });
    } catch (error) {
        console.error("API - POST /api/tenants/logo - Error:", error);
        return NextResponse.json({ error: "Failed to generate upload URL" }, { status: 500 });
    }
}

/**
 * PUT — Save logo S3 key to TenantConfig after client upload completes.
 * Per D-12: stores the S3 key in TenantConfig (configKey = 'org_logo').
 */
export async function PUT(req: NextRequest) {
    try {
        const authError = await authorize("update", "Tenant");
        if (authError) return authError;

        const session = await getAuthSession();
        const tenantId = await getSessionTenantId();

        const body = await req.json();
        const parsed = saveLogoSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                { error: parsed.error.issues[0].message },
                { status: 400 }
            );
        }

        const publicUrl = env.ASSETS_CDN_URL
            ? `${env.ASSETS_CDN_URL}/${parsed.data.key}`
            : `https://${env.APP_BUCKET_NAME}.s3.${env.AWS_REGION}.amazonaws.com/${parsed.data.key}`;

        await TenantSettingsService.saveLogo(
            tenantId,
            { key: parsed.data.key, url: publicUrl },
            session!.user.id
        );

        AuditService.logUserAction({
            eventType: 'tenant.logo.updated',
            severity: 'low',
            apiRoute: 'PUT /api/tenants/logo',
            httpMethod: 'PUT',
            action: 'Updated Logo',
            resourceType: 'tenant',
            resourceId: tenantId,
            resourceName: parsed.data.key,
            user: session!.user.email || session!.user.id,
            userType: 'user',
            status: 'success',
            details: `Updated organization logo: ${parsed.data.key}`,
            metadata: { tenantId, key: parsed.data.key, publicUrl },
        }).catch(() => {});

        console.log(`API - PUT /api/tenants/logo - Saved logo for tenant ${tenantId}`);

        return NextResponse.json({ success: true, logoUrl: publicUrl });
    } catch (error) {
        console.error("API - PUT /api/tenants/logo - Error:", error);
        AuditService.logUserAction({
            eventType: 'tenant.logo.updated',
            severity: 'low',
            apiRoute: 'PUT /api/tenants/logo',
            httpMethod: 'PUT',
            action: 'Updated Logo',
            resourceType: 'tenant',
            resourceId: 'unknown',
            resourceName: 'unknown',
            user: 'unknown',
            userType: 'user',
            status: 'error',
            details: `Failed to update logo: ${error instanceof Error ? error.message : 'Unknown error'}`,
            metadata: {},
        }).catch(() => {});
        return NextResponse.json({ error: "Failed to save logo" }, { status: 500 });
    }
}
