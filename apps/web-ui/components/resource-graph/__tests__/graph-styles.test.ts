import { describe, it, expect } from 'vitest';
import type { StylesheetStyle } from 'cytoscape';
import { buildStylesheet } from '../graph-styles';
import { RESOURCE_TYPE_COLORS } from '@/lib/resource-graph/graph-theme';

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_PROP = /color$/i;
const RELATION_KINDS = ['traffic', 'reachability', 'containment', 'attachment', 'observation', 'other'];

describe('buildStylesheet', () => {
    const sheet = buildStylesheet() as unknown as StylesheetStyle[];
    const selectors = sheet.map((block) => block.selector);

    it('styles the base node, account, hub and compound-parent selectors', () => {
        expect(selectors).toContain('node');
        expect(selectors).toContain('node.account');
        expect(selectors).toContain('node.hub');
        expect(selectors).toContain('$node > node');
    });

    it('styles the base edge selector and one selector per relation kind', () => {
        expect(selectors).toContain('edge');
        for (const kind of RELATION_KINDS) {
            expect(selectors.some((s) => s.includes(kind))).toBe(true);
        }
    });

    it('renders observation edges as quiet dashed annotation, not hidden', () => {
        const block = sheet.find((b) => b.selector.includes('observation'));
        expect(block).toBeDefined();
        const style = block!.style as Record<string, unknown>;
        expect(style.display).not.toBe('none');
        expect(style['line-style']).toBe('dashed');
    });

    it('never hardcodes a colour outside RESOURCE_TYPE_COLORS; every other colour is a CSS variable reference', () => {
        const knownHexValues = new Set(Object.values(RESOURCE_TYPE_COLORS));
        let sawColorProp = false;
        for (const block of sheet) {
            const style = block.style as unknown as Record<string, unknown>;
            for (const [prop, value] of Object.entries(style)) {
                if (typeof value !== 'string') continue;
                if (HEX_COLOR.test(value)) {
                    expect(knownHexValues.has(value)).toBe(true);
                    continue;
                }
                if (COLOR_PROP.test(prop)) {
                    sawColorProp = true;
                    expect(value === 'data(color)' || value.includes('var(--')).toBe(true);
                }
            }
        }
        expect(sawColorProp).toBe(true);
    });
});
