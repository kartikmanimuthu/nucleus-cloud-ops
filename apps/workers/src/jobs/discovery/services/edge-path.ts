import type { EdgeTransform } from '../types.js';

export function resolvePath(obj: unknown, path: string): unknown[] {
    if (obj === null || typeof obj !== 'object') return [];

    const segments = path.split('.');
    let current: unknown[] = [obj];

    for (const segment of segments) {
        const fanOut = segment.endsWith('[]');
        const key = fanOut ? segment.slice(0, -2) : segment;
        const next: unknown[] = [];

        for (const node of current) {
            if (node === null || typeof node !== 'object') continue;
            const value = (node as Record<string, unknown>)[key];
            if (value === null || value === undefined) continue;

            if (fanOut) {
                if (Array.isArray(value)) next.push(...value.filter((v) => v !== null && v !== undefined));
            } else {
                next.push(value);
            }
        }

        current = next;
        if (!current.length) return [];
    }

    return current;
}

export function applyTransform(value: string, transform?: EdgeTransform): string[] {
    if (transform === 'csv') {
        return value.split(',').map((v) => v.trim()).filter(Boolean);
    }
    if (transform === 'arn-last-segment') {
        if (!value.startsWith('arn:')) return [value];
        const last = value.split('/').pop();
        return last ? [last] : [];
    }
    return [value];
}
