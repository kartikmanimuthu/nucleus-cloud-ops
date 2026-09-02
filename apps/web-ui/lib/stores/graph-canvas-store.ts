import { create } from 'zustand';
import type { CyElement } from '@/lib/resource-graph/build-elements';

interface GraphCanvasStore {
    elements: CyElement[];
    expanded: Set<string>;
    selectedId: string | null;
    hiddenCounts: Record<string, number>;
    /**
     * Bumped by reset(), which is the only action that replaces the graph wholesale rather
     * than adding to it. The canvas relayouts from scratch when this changes: fcose needs
     * randomized starting positions for a brand-new element set, and without them a set with
     * few edges — switching to the estate view, 99 accounts and almost no relationships —
     * collapses into a diagonal line.
     */
    layoutEpoch: number;
    reset: (elements: CyElement[]) => void;
    addElements: (elements: CyElement[]) => void;
    markExpanded: (id: string, hiddenTotal: number) => void;
    collapse: (id: string) => void;
    select: (id: string | null) => void;
}

export const useGraphCanvasStore = create<GraphCanvasStore>()((set) => ({
    elements: [],
    expanded: new Set(),
    selectedId: null,
    hiddenCounts: {},
    layoutEpoch: 0,
    reset: (elements) => set((state) => ({
        elements,
        expanded: new Set(),
        selectedId: null,
        hiddenCounts: {},
        layoutEpoch: state.layoutEpoch + 1,
    })),
    addElements: (elements) => set((state) => {
        const existingIds = new Set(state.elements.map((e) => e.data.id));
        const additions = elements.filter((e) => !existingIds.has(e.data.id));
        return { elements: [...state.elements, ...additions] };
    }),
    markExpanded: (id, hiddenTotal) => set((state) => ({
        expanded: new Set(state.expanded).add(id),
        hiddenCounts: { ...state.hiddenCounts, [id]: hiddenTotal },
    })),
    collapse: (id) => set((state) => {
        const expanded = new Set(state.expanded);
        expanded.delete(id);
        const { [id]: _removed, ...hiddenCounts } = state.hiddenCounts;
        return { expanded, hiddenCounts };
    }),
    select: (id) => set({ selectedId: id }),
}));
