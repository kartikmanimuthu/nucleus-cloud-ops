# Requirements: Nucleus Cloud Ops — v5.0 Horizontal Worker Architecture

**Defined:** 2026-04-08
**Core Value:** WORKER_ARCH env-driven execution strategy so pg-boss jobs can run in-process (vertical) or dispatch to ephemeral ECS Fargate tasks (horizontal).

## v5.0 Requirements

### Executor Abstraction

- [ ] **EXEC-01**: Worker process selects execution strategy via WORKER_ARCH env variable (vertical | horizontal)
- [ ] **EXEC-02**: Generic JobExecutor interface defines execute(jobName, jobData) contract that all strategies implement
- [ ] **EXEC-03**: VerticalExecutor runs job handler in-process within the pg-boss worker (current behavior, zero regression)
- [ ] **EXEC-04**: HorizontalExecutor launches an ECS RunTask per job, passing job name and serialized job data via container overrides

### Job Wiring

- [x] **WIRE-01**: Scheduler job (per-tenant cron scan) delegates execution through the executor abstraction
- [x] **WIRE-02**: Discovery job (fan-out + per-tenant scan) delegates execution through the executor abstraction
- [x] **WIRE-03**: KB sync job (file-upload, s3-sync, confluence-sync, bitbucket-sync) delegates execution through the executor abstraction
- [ ] **WIRE-04**: Job runner entrypoint receives job name + data args, runs the handler directly, and exits the container

### Infrastructure

- [ ] **INFRA-01**: ECS task definition for ephemeral worker containers using the same Docker image with a different command
- [ ] **INFRA-02**: IAM task execution role and task role with permissions for STS AssumeRole, RDS, S3, Bedrock access
- [ ] **INFRA-03**: Pulumi code provisions task definition, security group, and CloudWatch log group for ephemeral workers

## Future Requirements

### Observability

- **OBS-01**: Dead letter queue for failed horizontal tasks with alerting
- **OBS-02**: Job execution metrics (duration, success/failure rate) per execution strategy
- **OBS-03**: Cost tracking dashboard comparing vertical vs horizontal resource usage

### Scaling

- **SCALE-01**: Auto-scaling rules for horizontal task concurrency limits
- **SCALE-02**: Per-job-type resource allocation (CPU/memory) configuration

## Out of Scope

| Feature | Reason |
|---------|--------|
| Kubernetes/EKS execution backend | ECS Fargate is the existing platform; no need for K8s complexity |
| SQS-based job dispatch (replacing pg-boss) | pg-boss is working well; horizontal mode adds ECS dispatch on top |
| Spot/Fargate Spot for ephemeral tasks | Cost optimization — defer until horizontal mode is proven |
| Per-job Docker images | Same image with different entrypoint is simpler and sufficient |
| Job result callback to pg-boss | pg-boss marks job complete when handler returns; horizontal executor waits for ECS task exit |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EXEC-01 | Phase 22 | Pending |
| EXEC-02 | Phase 22 | Pending |
| EXEC-03 | Phase 22 | Pending |
| EXEC-04 | Phase 24 | Pending |
| WIRE-01 | Phase 23 | Complete |
| WIRE-02 | Phase 23 | Complete |
| WIRE-03 | Phase 23 | Complete |
| WIRE-04 | Phase 23 | Pending |
| INFRA-01 | Phase 24 | Pending |
| INFRA-02 | Phase 24 | Pending |
| INFRA-03 | Phase 24 | Pending |

**Coverage:**
- v5.0 requirements: 11 total
- Mapped to phases: 11
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-08*
*Last updated: 2026-04-08 — traceability mapped after roadmap creation*
