import { describe, it, expect, beforeEach } from 'vitest';
import { useGraphCanvasStore } from '../graph-canvas-store';

const el = (id: string) => ({ data: { id } });

describe('graph canvas store', () => {
    beforeEach(() => { useGraphCanvasStore.getState().reset([]); });

    it('reset replaces everything and clears expansion state', () => {
        const s = useGraphCanvasStore.getState();
        s.addElements([el('a')]);
        s.markExpanded('a', 5);
        s.reset([el('b')]);

        const next = useGraphCanvasStore.getState();
        expect(next.elements.map((e) => e.data.id)).toEqual(['b']);
        expect(next.expanded.size).toBe(0);
        expect(next.hiddenCounts).toEqual({});
    });

    // The canvas keys its "lay this out from scratch" decision on layoutEpoch. Switching to
    // the estate view replaces the graph with ~99 accounts and almost no edges; laid out
    // without randomized starting positions, fcose collapses that into a diagonal line.
    it('reset bumps layoutEpoch so a replaced graph is laid out afresh', () => {
        const before = useGraphCanvasStore.getState().layoutEpoch;
        useGraphCanvasStore.getState().reset([el('a')]);
        expect(useGraphCanvasStore.getState().layoutEpoch).toBe(before + 1);
    });

    it('adding to the graph leaves layoutEpoch alone, so the picture holds still', () => {
        useGraphCanvasStore.getState().reset([el('a')]);
        const epoch = useGraphCanvasStore.getState().layoutEpoch;

        const s = useGraphCanvasStore.getState();
        s.addElements([el('b')]);
        s.markExpanded('a', 3);
        s.select('b');
        s.collapse('a');

        expect(useGraphCanvasStore.getState().layoutEpoch).toBe(epoch);
    });

    it('addElements ignores an element whose id is already present', () => {
        const s = useGraphCanvasStore.getState();
        s.addElements([el('a')]);
        s.addElements([el('a'), el('b')]);
        expect(useGraphCanvasStore.getState().elements.map((e) => e.data.id)).toEqual(['a', 'b']);
    });

    it('records how many neighbours an expansion withheld', () => {
        const s = useGraphCanvasStore.getState();
        s.markExpanded('vpc-1', 236);
        const next = useGraphCanvasStore.getState();
        expect(next.expanded.has('vpc-1')).toBe(true);
        expect(next.hiddenCounts['vpc-1']).toBe(236);
    });

    it('collapse removes the node from the expanded set so it can be expanded again', () => {
        const s = useGraphCanvasStore.getState();
        s.markExpanded('vpc-1', 0);
        s.collapse('vpc-1');
        expect(useGraphCanvasStore.getState().expanded.has('vpc-1')).toBe(false);
    });

    it('selecting a node does not change what is on the canvas', () => {
        const s = useGraphCanvasStore.getState();
        s.addElements([el('a')]);
        s.select('a');
        const next = useGraphCanvasStore.getState();
        expect(next.selectedId).toBe('a');
        expect(next.elements).toHaveLength(1);
    });
});
