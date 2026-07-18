import { describe, it, expect } from 'vitest';
import { buildMemoryPart } from '@/app/api/chat/stream-parts';

describe('buildMemoryPart', () => {
    it('counts markdown bullets (-) and returns them as `count`', () => {
        const summary = '- recalled fact one\n- recalled fact two\n- recalled fact three';
        const part = buildMemoryPart('recall', summary);
        expect(part.type).toBe('data-memory');
        expect(part.data).toEqual({ op: 'recall', summary, count: 3 });
    });

    it('counts `•` bullets', () => {
        const summary = '• fact one\n• fact two';
        const part = buildMemoryPart('save', summary);
        expect((part.data as any).count).toBe(2);
    });

    it('counts mixed -, *, • bullet markers', () => {
        const summary = '- fact one\n* fact two\n• fact three';
        const part = buildMemoryPart('recall', summary);
        expect((part.data as any).count).toBe(3);
    });

    it('returns count: null for prose with no bullets', () => {
        const summary = 'Recalled a general preference about deployment timing.';
        const part = buildMemoryPart('recall', summary);
        expect((part.data as any).count).toBeNull();
    });

    it('sets op to the passed value', () => {
        expect((buildMemoryPart('save', 'no bullets here').data as any).op).toBe('save');
        expect((buildMemoryPart('recall', 'no bullets here').data as any).op).toBe('recall');
    });
});
