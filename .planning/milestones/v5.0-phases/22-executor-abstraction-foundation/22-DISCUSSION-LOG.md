# Phase 22: Executor Abstraction Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-09
**Phase:** 22-executor-abstraction-foundation
**Areas discussed:** Interface contract, Strategy wiring, Handler extraction, Error propagation
**Mode:** Auto (--auto flag, all recommended defaults selected)

---

## Interface Contract

| Option | Description | Selected |
|--------|-------------|----------|
| jobName + jobData (generic) | Single execute(jobName, jobData) method — job-specific context inside jobData | ✓ |
| Typed per-job methods | Separate methods per job type (executeScheduler, executeDiscovery, etc.) | |
| Job descriptor object | execute(JobDescriptor) with name, data, metadata, retryPolicy | |

**User's choice:** [auto] jobName + jobData (generic) — recommended default
**Notes:** Keeps interface minimal. All 4 jobs already pass context via their job data objects.

---

## Strategy Wiring

| Option | Description | Selected |
|--------|-------------|----------|
| Single factory at startup | Read WORKER_ARCH once in index.ts, create executor, pass to register() | ✓ |
| Per-job strategy selection | Each register() reads WORKER_ARCH and creates its own executor | |
| Middleware/decorator pattern | Wrap boss.work() with executor middleware | |

**User's choice:** [auto] Single factory at startup — recommended default
**Notes:** Simplest approach. One env read, one executor instance, passed through.

---

## Handler Extraction

| Option | Description | Selected |
|--------|-------------|----------|
| Extract + executor delegates | Named handler functions; boss.work() calls executor.execute() | ✓ |
| Keep inline, executor wraps | Executor wraps the entire boss.work() callback | |
| Handler registry pattern | Handlers self-register into a Map; executor looks up by name | |

**User's choice:** [auto] Extract + executor delegates — recommended default
**Notes:** Clean separation. register() owns pg-boss wiring, executor owns dispatch.

---

## Error Propagation

| Option | Description | Selected |
|--------|-------------|----------|
| Throw, let pg-boss retry | Executor throws on failure; pg-boss retryLimit/retryDelay handles it | ✓ |
| Executor-level retry wrapper | Executor has its own retry logic before surfacing to pg-boss | |
| Error callback pattern | Executor calls onError(jobName, error) hook for custom handling | |

**User's choice:** [auto] Throw, let pg-boss retry — recommended default
**Notes:** pg-boss already configured with retryLimit: 3, retryDelay: 30, retryBackoff: true. No need to duplicate.

---

## Claude's Discretion

- File organization within workers/src/
- Handler registry implementation details
- Class vs function style for executor implementations

## Deferred Ideas

None — discussion stayed within phase scope
