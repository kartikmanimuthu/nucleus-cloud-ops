import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EDGE_SPECS } from '../services/edge-spec.js';
import { CUSTOM_DERIVERS } from '../services/edge-derivers.js';
import { normalizeResources } from '../services/scanner.js';
import { extractEdges } from '../services/edge-extractor.js';
import type { Resource } from '../types.js';

// Resource types the graph deliberately references without discovery scanning them.
// Anything else that shows up here is a typo, and a typo means silently zero edges.
const UNSCANNED_BY_DESIGN = new Set(['iam_instance_profiles']);

// Derives the resourceType strings discovery actually emits, by running the real
// normalizeResources over every scanfile entry. Spec keys are compared against these
// rather than against hand-written names: normalizeResources strips 'describe_',
// 'list_' and 'get_' anywhere in the string, so the emitted type is not always the
// obvious one (elbv2 describe_target_groups becomes elbv2_targroups, not
// elbv2_target_groups, because 'get_' is stripped out of the middle of "target_groups").
function scannedResourceTypes(): Set<string> {
    const scanfilePath = join(dirname(fileURLToPath(import.meta.url)), '../scanfile.json');
    const configs = JSON.parse(readFileSync(scanfilePath, 'utf-8')) as Array<{ service: string; function: string }>;
    const types = new Set<string>();
    for (const cfg of configs) {
        const [resource] = normalizeResources([{ probe: 1 }], cfg.service, cfg.function, 'us-east-1');
        if (resource) types.add(resource.resourceType);
    }
    return types;
}

describe('EDGE_SPECS ↔ discovery resource types', () => {
    it('keys every spec on a resource type discovery actually emits', () => {
        const scanned = scannedResourceTypes();
        const orphans = Object.keys(EDGE_SPECS).filter((k) => !scanned.has(k));
        expect(orphans, `these spec keys match no scanned resourceType, so they emit no edges: ${orphans.join(', ')}`).toEqual([]);
    });

    it('keys every custom deriver on a resource type discovery actually emits', () => {
        const scanned = scannedResourceTypes();
        const orphans = Object.keys(CUSTOM_DERIVERS).filter((k) => !scanned.has(k));
        expect(orphans, `these deriver keys never run: ${orphans.join(', ')}`).toEqual([]);
    });

    it('points every edge at a scanned resource type, or one listed as unscanned by design', () => {
        const scanned = scannedResourceTypes();
        const dangling = [...new Set(Object.values(EDGE_SPECS).flat().map((s) => s.toType))]
            .filter((t) => !scanned.has(t) && !UNSCANNED_BY_DESIGN.has(t));
        expect(dangling, `these edge targets can never resolve to an inventory resource: ${dangling.join(', ')}`).toEqual([]);
    });
});

describe('EDGE_SPECS', () => {
    it('covers the six core resource types', () => {
        for (const type of [
            'ec2_instances',
            'ec2_subnets',
            'ec2_security_groups',
            'ec2_volumes',
            'rds_db_instances',
            'elbv2_load_balancers',
        ]) {
            expect(EDGE_SPECS[type], `missing spec for ${type}`).toBeDefined();
            expect(EDGE_SPECS[type].length).toBeGreaterThan(0);
        }
    });

    it('provides a load-balancer to instance path via target groups', () => {
        const tg = EDGE_SPECS.elbv2_targroups;
        expect(tg.some((s) => s.toType === 'elbv2_load_balancers')).toBe(true);
        expect(tg.some((s) => s.toType === 'ec2_instances')).toBe(true);
    });

    it('links an elastic ip to its instance and network interface', () => {
        const addr = EDGE_SPECS.ec2_addresses;
        expect(addr.some((s) => s.toType === 'ec2_instances')).toBe(true);
        expect(addr.some((s) => s.toType === 'ec2_network_interfaces')).toBe(true);
    });

    it('uses arn-last-segment for every kms_keys, iam_roles and instance-profile target', () => {
        for (const [fromType, specs] of Object.entries(EDGE_SPECS)) {
            for (const spec of specs) {
                if (['kms_keys', 'iam_roles', 'iam_instance_profiles'].includes(spec.toType)) {
                    expect(spec.transform, `${fromType} → ${spec.toType} must transform ARNs`).toBe('arn-last-segment');
                }
            }
        }
    });

    it('never transforms sns_topics, ecs_clusters or acm_certificates targets (ids are full ARNs)', () => {
        for (const specs of Object.values(EDGE_SPECS)) {
            for (const spec of specs) {
                if (['sns_topics', 'ecs_clusters', 'acm_certificates'].includes(spec.toType)) {
                    expect(spec.transform).toBeUndefined();
                }
            }
        }
    });

    it('gives every spec a non-empty path, relation and toType', () => {
        for (const specs of Object.values(EDGE_SPECS)) {
            for (const spec of specs) {
                expect(spec.path).toBeTruthy();
                expect(spec.relation).toBeTruthy();
                expect(spec.toType).toBeTruthy();
            }
        }
    });
});

describe('s3_buckets encryption edge', () => {
    function bucket(rawData: unknown): Resource {
        return {
            resourceType: 's3_buckets',
            resourceId: 'my-bucket',
            region: 'us-east-1',
            service: 's3',
            tags: {},
            rawData,
        };
    }

    it('derives a kms_keys edge from an SSE-KMS bucket', () => {
        const edges = extractEdges([
            bucket({
                Name: 'my-bucket',
                ServerSideEncryptionConfiguration: {
                    Rules: [{
                        ApplyServerSideEncryptionByDefault: {
                            SSEAlgorithm: 'aws:kms',
                            KMSMasterKeyID: 'arn:aws:kms:us-east-1:123456789012:key/abcd-1234',
                        },
                    }],
                },
            }),
        ], 'test-account');

        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({
            fromType: 's3_buckets',
            fromId: 'my-bucket',
            relation: 'encrypted_with',
            toType: 'kms_keys',
            toId: 'abcd-1234',
        });
    });

    // AES256 (SSE-S3) has no KMSMasterKeyID at all — the most common bucket
    // configuration, and a spec that emitted an edge here would be a fabrication.
    it('emits no edge for an SSE-S3 (AES256) bucket', () => {
        const edges = extractEdges([
            bucket({
                Name: 'my-bucket',
                ServerSideEncryptionConfiguration: {
                    Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
                },
            }),
        ], 'test-account');

        expect(edges).toHaveLength(0);
    });

    it('emits no edge when the encryption enrichment never ran', () => {
        const edges = extractEdges([bucket({ Name: 'my-bucket' })], 'test-account');

        expect(edges).toHaveLength(0);
    });
});
