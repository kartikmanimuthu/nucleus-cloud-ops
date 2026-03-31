---
phase: 10-ecs-alb-cloudfront
plan: 02
subsystem: infra
tags: [pulumi, ecs, alb, fargate, autoscaling, security-groups, cloudfront]

requires:
  - phase: 10-01
    provides: ECS cluster, WebUI task definition, ECR repo, ECS task role

provides:
  - ALB (internet-facing, HTTP, idleTimeout 1200s) with CloudFront-restricted security group
  - Target group with /api/health health check (interval 60s, timeout 5s, 2/3 thresholds)
  - HTTP listener on port 80 forwarding to target group
  - ECS Fargate service with forceNewDeployment, circuit breaker+rollback, desiredCount 0
  - Auto scaling: min 2 / max 10, CPU 70% + Memory 75% target tracking
  - ALB SG (port 80 from CloudFront prefix list) + ECS SG (port 3000 from ALB SG)

affects: [10-03-cloudfront, phase-11-s3-vectors]

tech-stack:
  added: [aws.lb.LoadBalancer, aws.lb.TargetGroup, aws.lb.Listener, aws.appautoscaling.Target, aws.appautoscaling.Policy, aws.ec2.getManagedPrefixListOutput]
  patterns: [CloudFront-restricted ALB ingress via managed prefix list, ECS circuit breaker with rollback, target tracking auto scaling]

key-files:
  created: []
  modified:
    - infra/compute/index.ts

key-decisions:
  - "ALB inbound restricted to CloudFront managed prefix list (com.amazonaws.global.cloudfront.origin-facing) — not open to internet"
  - "ECS service desiredCount=0 at deploy time — scale up manually after smoke testing"
  - "dependsOn: [httpListener] on ECS service — ensures listener exists before service registers targets"

patterns-established:
  - "CloudFront prefix list lookup: aws.ec2.getManagedPrefixListOutput for dynamic prefix list ID"
  - "ECS circuit breaker: deploymentCircuitBreaker.enable=true + rollback=true"
  - "Auto scaling: separate CPU + Memory policies both referencing same scalingTarget"

requirements-completed: [PULUMI-13, PULUMI-14]

duration: 12min
completed: 2026-03-30
---

# Phase 10 Plan 02: ECS ALB CloudFront Summary

**ALB (internet-facing, CloudFront-restricted, 1200s idle timeout) + ECS Fargate service (circuit breaker, forceNewDeployment) + CPU/Memory auto scaling wired to Pulumi compute stack**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-30T11:40:00Z
- **Completed:** 2026-03-30T11:52:00Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- ALB and security groups with CloudFront managed prefix list restriction on port 80
- ECS Fargate service with circuit breaker, rollback, forceNewDeployment, and ALB target group wiring
- Auto scaling target tracking policies for CPU (70%) and Memory (75%)

## Task Commits

1. **Task 1 + 2: ALB, security groups, ECS service, auto scaling** - `35346d0` (feat)

**Plan metadata:** (pending)

## Files Created/Modified
- `infra/compute/index.ts` - Added ALB SG, ECS SG, ALB, target group, HTTP listener, ECS Fargate service, auto scaling target + CPU/Memory policies

## Decisions Made
- ALB inbound restricted to CloudFront managed prefix list — not open to 0.0.0.0/0
- ECS service desiredCount=0 at deploy — safe start, scale up after smoke testing
- `dependsOn: [httpListener]` on ECS service ensures listener is ready before target registration

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## Next Phase Readiness
- ALB DNS name available as stack output after `pulumi up`
- Plan 03 (CloudFront) can reference ALB DNS name via stack output to create CloudFront distribution
- ECS service at desiredCount=0 — set to 2 after CloudFront is wired and smoke tested

---
*Phase: 10-ecs-alb-cloudfront*
*Completed: 2026-03-30*
