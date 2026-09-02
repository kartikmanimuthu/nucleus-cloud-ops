import { describe, it, expect } from 'vitest';
import { buildSQLGenerationPrompt, buildReflectionPrompt, buildSynthesisPrompt } from './prompts';

describe('buildSQLGenerationPrompt', () => {
    it('includes the schema description and sample rows', () => {
        const prompt = buildSQLGenerationPrompt('id (uuid, nullable: NO)', [{ id: '1' }]);
        expect(prompt).toContain('id (uuid, nullable: NO)');
        expect(prompt).toContain('"id": "1"');
    });

    it('omits the filter section when no filters are given', () => {
        const prompt = buildSQLGenerationPrompt('schema', []);
        expect(prompt).not.toContain('Active inventory filters');
    });

    it('includes a valid accountIds filter, dropping malformed ids', () => {
        const prompt = buildSQLGenerationPrompt('schema', [], { accountIds: ['123456789012', 'not-an-id'] });
        expect(prompt).toContain("account_id IN ('123456789012')");
        expect(prompt).not.toContain('not-an-id');
    });

    it('drops the accountIds filter entirely when every id is malformed', () => {
        const prompt = buildSQLGenerationPrompt('schema', [], { accountIds: ['bad'] });
        expect(prompt).not.toContain('account_id IN');
    });

    it('includes a valid region filter and drops a malformed one', () => {
        const valid = buildSQLGenerationPrompt('schema', [], { region: 'us-east-1' });
        expect(valid).toContain("region = 'us-east-1'");

        const invalid = buildSQLGenerationPrompt('schema', [], { region: "'; DROP TABLE x;--" });
        expect(invalid).not.toContain('DROP TABLE');
        expect(invalid).not.toContain('region =');
    });

    it('includes a valid resourceType filter and drops a malformed one', () => {
        const valid = buildSQLGenerationPrompt('schema', [], { resourceType: 'ec2_instance' });
        expect(valid).toContain("resource_type = 'ec2_instance'");

        const invalid = buildSQLGenerationPrompt('schema', [], { resourceType: 'EC2 Instance!' });
        expect(invalid).not.toContain('resource_type =');
    });

    it('combines multiple valid filters', () => {
        const prompt = buildSQLGenerationPrompt('schema', [], { region: 'eu-west-1', resourceType: 'rds_instance' });
        expect(prompt).toContain("region = 'eu-west-1'");
        expect(prompt).toContain("resource_type = 'rds_instance'");
    });
});

describe('buildReflectionPrompt', () => {
    it('renders the error section when the query failed', () => {
        const prompt = buildReflectionPrompt('q', 'SELECT 1', null, 'syntax error');
        expect(prompt).toContain('Query Error:\nsyntax error');
    });

    it('renders row count and preview rows on success', () => {
        const prompt = buildReflectionPrompt('q', 'SELECT 1', { rows: [{ a: 1 }], rowCount: 1 }, null);
        expect(prompt).toContain('Row Count: 1');
        expect(prompt).toContain('"a": 1');
    });

    it('renders "No result returned." when there is no result and no error', () => {
        const prompt = buildReflectionPrompt('q', 'SELECT 1', null, null);
        expect(prompt).toContain('No result returned.');
    });
});

describe('buildSynthesisPrompt', () => {
    it('includes the retry caveat when wasRetried is true', () => {
        const prompt = buildSynthesisPrompt('q', 'SELECT 1', { rows: [], rowCount: 0 }, true);
        expect(prompt).toContain('required multiple attempts');
    });

    it('omits the retry caveat when wasRetried is false', () => {
        const prompt = buildSynthesisPrompt('q', 'SELECT 1', { rows: [], rowCount: 0 }, false);
        expect(prompt).not.toContain('required multiple attempts');
    });

    it('notes a truncated preview when rowCount exceeds the 100-row preview', () => {
        const rows = Array.from({ length: 150 }, (_, i) => ({ id: i }));
        const prompt = buildSynthesisPrompt('q', 'SELECT 1', { rows, rowCount: 150 }, false);
        expect(prompt).toContain('Showing first 100 of 150 rows');
    });

    it('does not note truncation when all rows are shown', () => {
        const prompt = buildSynthesisPrompt('q', 'SELECT 1', { rows: [{ id: 1 }], rowCount: 1 }, false);
        expect(prompt).not.toContain('Showing first');
    });
});
