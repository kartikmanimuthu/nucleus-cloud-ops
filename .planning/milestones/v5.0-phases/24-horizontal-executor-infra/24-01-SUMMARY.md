---
phase: 24-horizontal-executor-infra
plan: 01
status: complete
started: 2026-04-09
completed: 2026-04-09
---

## Summary

Replaced the HorizontalExecutor stub with a full ECS RunTask dispatch implementation. The executor reads cluster ARN, task definition ARN, subnets, and security group from environment variables, launches an ephemeral Fargate task with job-runner.js command override, and polls DescribeTasks with exponential backoff (2s initial, 2x multiplier, 30s cap) until the task reaches STOPPED status. Returns on exit code 0, throws on non-zero with task ARN and stopped reason. Configurable timeout via HORIZONTAL_TASK_TIMEOUT_MS (default 15 min).

## Key Files

- `workers/src/executor/horizontal.ts` — Full HorizontalExecutor implementation
- `workers/src/executor/horizontal.test.ts` — 13 unit tests covering dispatch, polling, errors, timeout, backoff

## Decisions

- Env vars read at execute() time, not constructor — clear errors on first dispatch attempt
- Exponential backoff with 2s initial / 30s cap balances responsiveness vs API throttling
- No registerHandler() — horizontal executor dispatches to ECS, doesn't run handlers locally

## Verification

- 13/13 unit tests pass (`npx vitest run src/executor/horizontal.test.ts`)
- `npx tsc --noEmit` passes with no type errors
