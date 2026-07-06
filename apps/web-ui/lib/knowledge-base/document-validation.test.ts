import { describe, it, expect } from 'vitest';
import { validateDocumentInput, MAX_DOCUMENT_CHARS } from './document-validation';

describe('validateDocumentInput', () => {
    it('accepts a valid document and trims the name', () => {
        const r = validateDocumentInput({ name: '  Runbook  ', content: '# Steps' });
        expect(r).toEqual({ ok: true, name: 'Runbook', content: '# Steps' });
    });

    it('rejects an empty name', () => {
        const r = validateDocumentInput({ name: '   ', content: 'body' });
        expect(r).toEqual({ ok: false, error: 'name is required' });
    });

    it('rejects empty content', () => {
        const r = validateDocumentInput({ name: 'Doc', content: '   ' });
        expect(r).toEqual({ ok: false, error: 'content is required' });
    });

    it('rejects content over the size cap', () => {
        const r = validateDocumentInput({ name: 'Doc', content: 'a'.repeat(MAX_DOCUMENT_CHARS + 1) });
        expect(r.ok).toBe(false);
        expect((r as { error: string }).error).toContain('too large');
    });
});
