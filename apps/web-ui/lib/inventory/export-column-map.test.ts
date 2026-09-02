import { describe, it, expect } from 'vitest';
import { EXPORT_COLUMN_MAP, getExportColumnsForType, resolveExportValue } from './export-column-map';

describe('getExportColumnsForType', () => {
    it('returns the specific column set for a known resource type', () => {
        expect(getExportColumnsForType('ec2_instances')).toBe(EXPORT_COLUMN_MAP.ec2_instances);
    });

    it('falls back to _default for an unknown resource type', () => {
        expect(getExportColumnsForType('totally_unknown_type')).toBe(EXPORT_COLUMN_MAP._default);
    });

    it('every column set includes a Name column and the common tail fields', () => {
        for (const [type, columns] of Object.entries(EXPORT_COLUMN_MAP)) {
            expect(columns.some(c => c.accessor === 'name' || c.accessor === 'resourceId'), type).toBe(true);
            expect(columns.length).toBeGreaterThan(0);
        }
    });

    it('ssm_parameters omits the tags column (no Tags in the grid)', () => {
        const accessors = getExportColumnsForType('ssm_parameters').map(c => c.accessor);
        expect(accessors).not.toContain('tags');
    });

    it('_default includes the computed service and resourceType columns', () => {
        const accessors = EXPORT_COLUMN_MAP._default.map(c => c.accessor);
        expect(accessors).toContain('service');
        expect(accessors).toContain('resourceType');
    });
});

describe('resolveExportValue', () => {
    it('serializes tags as a JSON string', () => {
        expect(resolveExportValue({ tags: { env: 'prod' } }, 'tags')).toBe('{"env":"prod"}');
    });

    it('returns an empty string for missing or non-object tags', () => {
        expect(resolveExportValue({}, 'tags')).toBe('');
        expect(resolveExportValue({ tags: null }, 'tags')).toBe('');
        expect(resolveExportValue({ tags: 'not-an-object' }, 'tags')).toBe('');
    });

    it('computes the service name from resourceType for the "service" accessor', () => {
        const result = resolveExportValue({ resourceType: 'ec2_instances' }, 'service');
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
    });

    it('resolves a top-level field', () => {
        expect(resolveExportValue({ name: 'my-instance' }, 'name')).toBe('my-instance');
    });

    it('resolves a nested dot-path into metadata', () => {
        expect(resolveExportValue({ metadata: { instanceType: 't3.micro' } }, 'metadata.instanceType')).toBe('t3.micro');
    });

    it('returns an empty string when a dot-path segment is missing or non-object', () => {
        expect(resolveExportValue({}, 'metadata.instanceType')).toBe('');
        expect(resolveExportValue({ metadata: null }, 'metadata.instanceType')).toBe('');
        expect(resolveExportValue({ metadata: 'not-an-object' }, 'metadata.instanceType')).toBe('');
    });

    it('returns an empty string when the resolved value is null or undefined', () => {
        expect(resolveExportValue({ metadata: { x: null } }, 'metadata.x')).toBe('');
        expect(resolveExportValue({ metadata: { x: undefined } }, 'metadata.x')).toBe('');
    });

    it('formats a boolean value as Yes/No', () => {
        expect(resolveExportValue({ metadata: { encrypted: true } }, 'metadata.encrypted')).toBe('Yes');
        expect(resolveExportValue({ metadata: { encrypted: false } }, 'metadata.encrypted')).toBe('No');
    });

    it('joins an array value with commas', () => {
        expect(resolveExportValue({ metadata: { aliases: ['a.com', 'b.com'] } }, 'metadata.aliases')).toBe('a.com, b.com');
    });

    it('stringifies a plain value', () => {
        expect(resolveExportValue({ metadata: { size: 100 } }, 'metadata.size')).toBe('100');
    });
});
