/**
 * Projections shipped by /api/me/ability. Extracted so they are unit-testable
 * without standing up a session.
 */
import type { RegistrySnapshot } from '@nucleus/rbac';

export interface AbilityModuleAction {
    moduleKey: string;
    actionKey: string;
}

/**
 * The grid cells that exist, as (moduleKey, actionKey) pairs.
 *
 * Only `grantable` links are emitted. A non-grantable link is a cell the role
 * editor must render disabled, and `manage` never expands to it — offering it as
 * a tick would promise a grant the compiler does not produce.
 */
export function toAbilityModuleActions(registry: RegistrySnapshot): AbilityModuleAction[] {
    const moduleKeyById = new Map(registry.modules.map((m) => [m.id, m.key]));
    const actionKeyById = new Map(registry.actions.map((a) => [a.id, a.key]));

    const out: AbilityModuleAction[] = [];
    for (const link of registry.moduleActions) {
        if (!link.grantable) continue;
        const moduleKey = moduleKeyById.get(link.moduleId);
        const actionKey = actionKeyById.get(link.actionId);
        if (!moduleKey || !actionKey) continue;
        out.push({ moduleKey, actionKey });
    }
    return out;
}
