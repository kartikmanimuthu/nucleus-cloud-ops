import { describe, it, expect, vi } from 'vitest';

vi.mock('pdf-parse', () => ({ default: vi.fn().mockResolvedValue({ text: 'extracted pdf text' }) }));

import { isSupportedKey, getMime, parseContent } from './parsing.js';
import pdfParse from 'pdf-parse';

describe('isSupportedKey', () => {
    it.each(['doc.pdf', 'notes.md', 'file.txt', 'data.json', 'table.csv', 'config.yaml', 'config.yml'])(
        'accepts a supported extension: %s',
        (key) => expect(isSupportedKey(key)).toBe(true)
    );

    it('rejects an unsupported extension', () => {
        expect(isSupportedKey('archive.zip')).toBe(false);
    });

    it('is case-insensitive', () => {
        expect(isSupportedKey('DOC.PDF')).toBe(true);
    });

    it('rejects a key with no extension', () => {
        expect(isSupportedKey('README')).toBe(false);
    });
});

describe('getMime', () => {
    it('maps .pdf to application/pdf', () => {
        expect(getMime('doc.pdf')).toBe('application/pdf');
    });

    it('maps .json to application/json', () => {
        expect(getMime('data.json')).toBe('application/json');
    });

    it('falls back to text/plain for everything else', () => {
        expect(getMime('notes.md')).toBe('text/plain');
        expect(getMime('noextension')).toBe('text/plain');
    });
});

describe('parseContent', () => {
    it('parses PDF content via pdf-parse when mimeType is application/pdf', async () => {
        const result = await parseContent(Buffer.from('fake-pdf-bytes'), 'application/pdf', 'doc.pdf');
        expect(result).toBe('extracted pdf text');
        expect(pdfParse).toHaveBeenCalled();
    });

    it('parses PDF content when the filename ends in .pdf even if mimeType is generic', async () => {
        const result = await parseContent(Buffer.from('fake-pdf-bytes'), 'application/octet-stream', 'report.pdf');
        expect(result).toBe('extracted pdf text');
    });

    it('decodes non-PDF buffers as UTF-8 text', async () => {
        const result = await parseContent(Buffer.from('hello world', 'utf-8'), 'text/plain', 'notes.txt');
        expect(result).toBe('hello world');
    });
});
