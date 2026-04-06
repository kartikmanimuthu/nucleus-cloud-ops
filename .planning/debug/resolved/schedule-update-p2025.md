---
status: resolved
trigger: "PUT /api/schedules/STX_Data_Archive_Schedule returns 500 — Prisma P2025 Record to update not found"
created: 2026-04-06T00:00:00Z
updated: 2026-04-06T00:00:00Z
---

## Current Focus

hypothesis: Route passes URL param (schedule name) directly to updateSchedule/deleteSchedule, but the postgres repo's updateSchedule uses it as a scheduleId UUID in the WHERE clause — name never matches a UUID
test: Trace route.ts PUT handler → ScheduleService.updateSchedule → SchedulePostgresRepository.updateSchedule
expecting: Fix confirmed by using existing.id (UUID) from pre-flight getSchedule result
next_action: Apply fix to route.ts PUT and DELETE handlers; update broken tests

## Symptoms

expected: Schedule update succeeds and returns updated schedule
actual: Prisma throws P2025 — record not found during update
errors: |
  WHERE tenantId = $10 AND scheduleId = $11 (value: "STX_Data_Archive_Schedule")
  PrismaClientKnownRequestError P2025 — Record to update not found
reproduction: PUT /api/schedules/{scheduleName} with any schedule name in the URL
started: pg-boss-migration branch

## Eliminated

- hypothesis: tenantId mismatch causing the WHERE to fail
  evidence: Pre-flight getSchedule succeeds (returns the schedule), so tenantId is correct
  timestamp: 2026-04-06T00:00:00Z

## Evidence

- timestamp: 2026-04-06T00:00:00Z
  checked: route.ts PUT handler (line 40-54)
  found: scheduleId = URL param (e.g. "STX_Data_Archive_Schedule"); updateData = { ...body, id: scheduleId }; calls ScheduleService.updateSchedule(scheduleId, ...)
  implication: The name string is passed as scheduleId to the service

- timestamp: 2026-04-06T00:00:00Z
  checked: SchedulePostgresRepository.updateSchedule (line 177-179)
  found: WHERE clause uses tenantId_scheduleId composite unique key — expects a sched-* UUID, not a name
  implication: Passing a name causes P2025 because no row has scheduleId = "STX_Data_Archive_Schedule"

- timestamp: 2026-04-06T00:00:00Z
  checked: SchedulePostgresRepository.getSchedule (line 101-113)
  found: isUUID check = idOrName.startsWith('sched-'); falls through to name-based lookup when not UUID
  implication: Pre-flight getSchedule works fine with a name — returns the full record including the sched-* UUID as .id

- timestamp: 2026-04-06T00:00:00Z
  checked: transformToUISchedule (line 237)
  found: id: record.scheduleId — UISchedule.id is always the sched-* UUID
  implication: existing.id from the pre-flight check IS the correct UUID to pass to updateSchedule

## Resolution

root_cause: |
  The PUT (and DELETE) route handler passes the raw URL param (schedule name like "STX_Data_Archive_Schedule")
  directly to ScheduleService.updateSchedule/deleteSchedule. The postgres repository's updateSchedule uses
  this value in a WHERE tenantId_scheduleId composite unique key lookup, which expects a sched-* UUID.
  The pre-flight getSchedule call already resolves the name to the full record (including the UUID),
  but the route discards that UUID and passes the name instead.

fix: |
  In PUT handler: use existing.id (UUID from pre-flight) instead of scheduleId (name from URL) when
  calling updateSchedule, and set id in updateData to existing.id.
  In DELETE handler: use existing.id instead of scheduleId when calling deleteSchedule.
  Update two broken tests that don't mock getSchedule for the error cases.

verification: pending
files_changed:
  - web-ui/app/api/schedules/[scheduleId]/route.ts
  - web-ui/app/api/schedules/schedules-api.test.ts
