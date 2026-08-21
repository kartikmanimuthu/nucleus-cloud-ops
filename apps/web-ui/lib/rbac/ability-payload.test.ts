/**
 * The role grid renders its columns from this payload. If it shipped every
 * (module, action) pair rather than the grantable ones, the grid would offer
 * ticks that `manage` never expands to — a checkbox promising more than the
 * engine grants.
 */
import { describe, expect, it } from 'vitest';

import { toAbilityModuleActions } from './ability-payload';

describe('toAbilityModuleActions', () => {
    const snapshot = {
        modules: [{ id: 'm-acc', key: 'Accounts' }, { id: 'm-dash', key: 'Dashboard' }],
        actions: [{ id: 'a-read', key: 'read' }, { id: 'a-delete', key: 'delete' }],
        moduleActions: [
            { moduleId: 'm-acc', actionId: 'a-read', grantable: true },
            { moduleId: 'm-acc', actionId: 'a-delete', grantable: false },
            { moduleId: 'm-dash', actionId: 'a-read', grantable: true },
        ],
    };

    it('emits one entry per grantable cell', () => {
        expect(toAbilityModuleActions(snapshot as never)).toEqual([
            { moduleKey: 'Accounts', actionKey: 'read' },
            { moduleKey: 'Dashboard', actionKey: 'read' },
        ]);
    });

    it('drops a cell whose module or action is not in the snapshot', () => {
        const orphaned = { ...snapshot, moduleActions: [{ moduleId: 'gone', actionId: 'a-read', grantable: true }] };
        expect(toAbilityModuleActions(orphaned as never)).toEqual([]);
    });
});
