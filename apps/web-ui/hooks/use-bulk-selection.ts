"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * Generic row-selection state for bulk actions in list/table views.
 *
 * Tracks a set of selected ids and derives select-all / indeterminate state
 * against the ids currently in view. Stale ids (e.g. an item that left the
 * current page or was deleted) are ignored by the derived counts but kept in
 * the set until cleared, so they cause no crashes.
 */
export function useBulkSelection(allIds: string[]) {
    const [selected, setSelected] = useState<Set<string>>(new Set());

    const isSelected = useCallback(
        (id: string) => selected.has(id),
        [selected]
    );

    const toggle = useCallback((id: string, checked: boolean) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    }, []);

    const selectAll = useCallback(
        (checked: boolean) => {
            setSelected(checked ? new Set(allIds) : new Set());
        },
        [allIds]
    );

    const clear = useCallback(() => setSelected(new Set()), []);

    // Selection scoped to ids currently in view — the source of truth for the
    // toolbar count and any endpoint call.
    const selectedIds = useMemo(
        () => allIds.filter((id) => selected.has(id)),
        [allIds, selected]
    );

    const count = selectedIds.length;
    const allSelected = allIds.length > 0 && count === allIds.length;
    const someSelected = count > 0 && count < allIds.length;

    return {
        selectedIds,
        isSelected,
        toggle,
        selectAll,
        clear,
        count,
        allSelected,
        someSelected,
    };
}
