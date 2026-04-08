# Quick Task 260408-stg: Fix back button navigation across all modules

**Completed:** 2026-04-08
**Status:** Done

## What Changed

Fixed 3 broken `<Link>` hrefs in the schedules module that caused 404 errors by navigating to `/schedules/...` instead of `/app/schedules/...`.

### Files Modified

| File | Change |
|------|--------|
| `web-ui/app/app/schedules/[scheduleId]/history/[executionId]/page.tsx` | Fixed 2 back links: added `/app` prefix + `encodeURIComponent` |
| `web-ui/app/app/schedules/[scheduleId]/page.tsx` | Fixed edit link: added `/app` prefix + changed `schedule.name` → `schedule.id` |

### Specific Fixes

1. **Execution history error state back link** (line ~130): `/schedules/${scheduleId}` → `/app/schedules/${encodeURIComponent(scheduleId)}`
2. **Execution history header back link** (line ~156): `/schedules/${encodeURIComponent(scheduleId)}` → `/app/schedules/${encodeURIComponent(scheduleId)}`
3. **Schedule detail edit button** (line ~263): `/schedules/${encodeURIComponent(schedule.name)}/edit` → `/app/schedules/${encodeURIComponent(schedule.id)}/edit`

### Verification

- Grep sweep confirmed zero remaining `href={`/schedules/` without `/app` prefix
- Grep sweep confirmed zero broken navigation patterns across all modules (accounts, agent-ops, knowledge-base, members, inventory)
