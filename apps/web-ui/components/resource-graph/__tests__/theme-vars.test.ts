import { describe, it, expect } from 'vitest';
import { toCytoscapeHsl } from '../graph-styles';

// Cytoscape falls back to BLACK on any colour string it cannot parse, with no warning. That
// turned every themed colour into a black slab on the canvas and took a while to find, so the
// conversion is pinned here.
describe('toCytoscapeHsl', () => {
    it('converts tailwind space-separated channels to the comma form cytoscape parses', () => {
        expect(toCytoscapeHsl('0 0% 100%')).toBe('hsl(0, 0%, 100%)');
        expect(toCytoscapeHsl('222.2 84% 4.9%')).toBe('hsl(222.2, 84%, 4.9%)');
    });

    it('drops an alpha suffix rather than emitting something unparseable', () => {
        expect(toCytoscapeHsl('215 20% 65% / 0.35')).toBe('hsl(215, 20%, 65%)');
    });

    it('returns empty for a malformed value so the caller keeps its own fallback', () => {
        expect(toCytoscapeHsl('')).toBe('');
        expect(toCytoscapeHsl('nonsense')).toBe('');
    });
});
