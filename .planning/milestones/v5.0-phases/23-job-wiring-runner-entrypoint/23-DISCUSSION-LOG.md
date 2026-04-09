# Phase 23: Job Wiring + Runner Entrypoint - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-09
**Phase:** 23-job-wiring-runner-entrypoint
**Areas discussed:** Discovery wiring, Agent-ops-scheduler wiring, Job runner entrypoint, Fan-out orchestration

---

## Discovery Wiring

| Option | Description | Selected |
|--------|-------------|----------|
| Two handlers (handleFanOut + handleScan) registered separately | Extract both queue handlers as named functions, register with executor | ✓ |
| Single handler with type routing | One handler that switches on queue name | |

**User's choice:** [auto] Two handlers registered separately (recommended default)
**Notes:** Discovery has fundamentally different concerns: fan-out is orchestration, scan is execution. Separate handlers reflect this.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Fan-out stays as direct boss.send() | Fan-out is an orchestrator, not a job handler — needs boss instance | ✓ |
| Fan-out goes through executor.execute() | Treat fan-out as a regular job | |

**User's choice:** [auto] Fan-out stays as direct boss.send() (recommended default)
**Notes:** Fan-out needs boss.send() to enqueue scan jobs — can't work without pg-boss instance, so horizontal dispatch doesn't apply.

---

## Agent-Ops-Scheduler Wiring

| Option | Description | Selected |
|--------|-------------|----------|
| Wire through executor with registerHandler | Match Phase 22 pattern — extract handleAgentOpsTick, register, delegate | ✓ |
| Keep as-is without executor | Agent-ops is simple HTTP trigger, may not need abstraction | |

**User's choice:** [auto] Wire through executor with registerHandler (recommended default)
**Notes:** Consistency with all other jobs. Even though it's just an HTTP POST, wiring through executor means horizontal mode works uniformly.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Import and register in workers/src/index.ts | Add alongside scheduler and kb-sync registrations | ✓ |
| Keep agent-ops-scheduler separate | Don't add to main entrypoint | |

**User's choice:** [auto] Import and register in workers/src/index.ts (recommended default)
**Notes:** Currently missing from entrypoint — must be added for completeness.

---

## Job Runner Entrypoint

| Option | Description | Selected |
|--------|-------------|----------|
| CLI args: --job <name> --data '<json>' | Standard CLI pattern, easy to pass from ECS container overrides | ✓ |
| Environment variables: JOB_NAME + JOB_DATA | Simpler for container config | |

**User's choice:** [auto] CLI args (recommended default)
**Notes:** CLI args are more explicit and easier to debug in logs. ECS container overrides support both, but args are clearer.

---

| Option | Description | Selected |
|--------|-------------|----------|
| No pg-boss — import handlers directly | Job runner is a thin wrapper that calls handler and exits | ✓ |
| With pg-boss — fetch job from queue | Runner connects to pg-boss, fetches pending job, processes it | |

**User's choice:** [auto] No pg-boss (recommended default)
**Notes:** Job runner receives all data via args — no need for pg-boss connection. Simpler, faster startup, fewer dependencies.

---

## Fan-Out Orchestration

| Option | Description | Selected |
|--------|-------------|----------|
| Fan-out always in-process regardless of WORKER_ARCH | Needs boss.send() — can't dispatch horizontally | ✓ |
| Fan-out dispatches horizontally too | Would need boss instance passed through executor | |

**User's choice:** [auto] Always in-process (recommended default)
**Notes:** Fan-out is orchestration that enqueues child jobs. It must have access to the boss instance. Only scan jobs (the actual work) dispatch horizontally.

---

## Claude's Discretion

- CLI arg parsing approach (minimist, yargs, or manual process.argv)
- Build configuration for job-runner.ts entry
- Error message formatting for unknown job names

## Deferred Ideas

None — discussion stayed within phase scope
