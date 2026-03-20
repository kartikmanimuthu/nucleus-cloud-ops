import { createHash } from "crypto";

export interface InventoryResource {
    resourceId: string;
    resourceArn?: string;
    resourceType: string;
    name?: string;
    region: string;
    state?: string;
    accountId: string;
    accountName?: string;
    service?: string;
    tags?: Record<string, string>;
    metadata?: Record<string, unknown>;
    lastDiscoveredAt?: string;
    discoveryStatus?: string;
}

/**
 * Creates a human-readable text representation of an inventory resource
 * for use as input to the embedding model.
 * Mirrors the logic in vector_utils.py VectorGenerator.create_resource_text()
 */
export function createResourceText(resource: InventoryResource): string {
    const parts: string[] = [];

    // Core identification
    const name = resource.name || resource.resourceId || "Unknown";
    parts.push(`Name: ${name}`);
    parts.push(`Type: ${resource.resourceType || "Unknown"}`);
    parts.push(`Service: ${resource.service || resource.resourceType?.split("_")[0] || "Unknown"}`);

    // Location
    parts.push(`Region: ${resource.region || "Unknown"}`);
    parts.push(`Account: ${resource.accountName ? `${resource.accountName} (${resource.accountId})` : resource.accountId || "Unknown"}`);

    // State
    if (resource.state && resource.state !== "unknown") {
        parts.push(`State: ${resource.state}`);
    }

    // ARN (shortened for embedding efficiency)
    if (resource.resourceArn) {
        parts.push(`ARN: ${resource.resourceArn}`);
    }

    // Tags (flattened key=value)
    const tags = resource.tags;
    if (tags && typeof tags === "object" && Object.keys(tags).length > 0) {
        const tagList = Object.entries(tags)
            .slice(0, 20) // Cap at 20 tags to avoid token bloat
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
        parts.push(`Tags: ${tagList}`);
    }

    // VPC-specific: surface CIDR block prominently for semantic search
    if (resource.resourceType === "ec2_vpcs" && resource.metadata) {
        const cidr = resource.metadata.cidrBlock;
        if (cidr) parts.push(`CIDR: ${cidr}`);
        if (resource.metadata.isDefault) parts.push(`Default VPC: true`);
    }

    // Metadata (flattened simple scalar fields)
    const meta = resource.metadata;
    if (meta && typeof meta === "object") {
        const metaList: string[] = [];
        for (const [k, v] of Object.entries(meta)) {
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
                metaList.push(`${k}=${v}`);
            } else if (Array.isArray(v) && v.length > 0 && v.length < 5) {
                metaList.push(`${k}=${v.join(",")}`);
            }
        }
        if (metaList.length > 0) {
            parts.push(`Details: ${metaList.join(", ")}`);
        }
    }

    return parts.join(" | ");
}

/**
 * Computes a short content hash for delta deduplication.
 * If the text hasn't changed since the last embedding, we can skip re-embedding.
 */
export function computeContentHash(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
