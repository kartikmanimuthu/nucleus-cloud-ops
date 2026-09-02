// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { fence, anchor, downloadBlob, downloadText, fileSafe, yamlScalar } from '@/lib/export-utils';

describe('fence', () => {
    it('wraps content in a 3-backtick fence by default', () => {
        expect(fence('hello')).toBe('```markdown\nhello\n```');
    });

    it('uses a longer fence than the longest backtick run inside the content', () => {
        const content = 'a ```js\ncode\n``` block';
        expect(fence(content)).toBe('````markdown\n' + content + '\n````');
    });

    it('accepts a custom language tag', () => {
        expect(fence('x', 'json')).toBe('```json\nx\n```');
    });
});

describe('anchor', () => {
    it('lowercases, trims, and hyphenates spaces', () => {
        expect(anchor('  Stop EC2 At Night  ')).toBe('stop-ec2-at-night');
    });

    it('drops non-word, non-hyphen, non-space characters', () => {
        expect(anchor('Cost & Usage (2026)!')).toBe('cost-usage-2026');
    });
});

describe('fileSafe', () => {
    it('lowercases and hyphenates non-alphanumeric runs', () => {
        expect(fileSafe('Stop EC2 at Night!')).toBe('stop-ec2-at-night');
    });

    it('trims leading/trailing hyphens', () => {
        expect(fileSafe('--already-hyphenated--')).toBe('already-hyphenated');
    });

    it('falls back to the given fallback when the result is empty', () => {
        expect(fileSafe('!!!', 'skill')).toBe('skill');
    });

    it('falls back to "item" when no fallback is given', () => {
        expect(fileSafe('!!!')).toBe('item');
    });
});

describe('yamlScalar', () => {
    it('double-quotes a single-line value', () => {
        expect(yamlScalar('hello')).toBe('"hello"');
    });

    it('escapes backslashes and double quotes', () => {
        expect(yamlScalar('a "quoted" \\path')).toBe('"a \\"quoted\\" \\\\path"');
    });

    it('uses a block scalar for multi-line values', () => {
        expect(yamlScalar('line one\nline two')).toBe('|-\n  line one\n  line two');
    });

    it('treats a nullish value as an empty string', () => {
        expect(yamlScalar(undefined as unknown as string)).toBe('""');
    });
});

describe('downloadText / downloadBlob (DOM download trigger)', () => {
    it('creates an anchor, clicks it with the filename, and revokes the object URL', () => {
        const created: HTMLAnchorElement[] = [];
        const realCreateElement = document.createElement.bind(document);
        document.createElement = ((tag: string) => {
            const el = realCreateElement(tag);
            if (tag === 'a') {
                el.click = () => { (el as any)._clicked = true; };
                created.push(el as HTMLAnchorElement);
            }
            return el;
        }) as typeof document.createElement;

        try {
            downloadText('hello world', 'notes.md');

            expect(created).toHaveLength(1);
            expect(created[0].download).toBe('notes.md');
            expect(created[0].href).toMatch(/^blob:/);
            expect((created[0] as any)._clicked).toBe(true);
            expect(document.body.contains(created[0])).toBe(false); // removed after click
        } finally {
            document.createElement = realCreateElement;
        }
    });

    it('downloadText defaults to a markdown mime type', () => {
        let capturedBlob: Blob | null = null;
        const realCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = ((blob: Blob) => { capturedBlob = blob; return realCreateObjectURL(blob); }) as typeof URL.createObjectURL;

        try {
            downloadText('# hi', 'file.md');
            expect(capturedBlob?.type).toBe('text/markdown;charset=utf-8');
        } finally {
            URL.createObjectURL = realCreateObjectURL;
        }
    });

    it('downloadBlob passes the given blob through untouched', () => {
        let capturedBlob: Blob | null = null;
        const realCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = ((blob: Blob) => { capturedBlob = blob; return realCreateObjectURL(blob); }) as typeof URL.createObjectURL;

        try {
            const blob = new Blob(['zip-bytes'], { type: 'application/zip' });
            downloadBlob(blob, 'export.zip');
            expect(capturedBlob).toBe(blob);
        } finally {
            URL.createObjectURL = realCreateObjectURL;
        }
    });
});
