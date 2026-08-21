-- Widen Scale Sentinel's scope CHECK constraints to admit four new resource
-- types: rds, msk, elasticache, docdb. None of these expose a unified
-- "scaling activity" API the way ECS/ASG's DescribeScalingActivities does, so
-- every event for them is captured via CloudTrail (or, for RDS, also via its
-- own automated storage-autoscaling feature) — hence the new 'direct_api'
-- reuse below and the one genuinely new scalingType, 'storage_autoscaling',
-- for the one case where AWS itself (not a human/pipeline caller) initiated
-- the change.
--
-- Reuses the existing scaling_events/watermarks/coverage/policy-snapshots
-- tables rather than new per-service tables — their columns (resourceId,
-- cause, capacity before/after, actor, rawPayload) are already generic;
-- only clusterName/serviceName/asgName stay null for the new scopes.
--
-- Hand-authored per CLAUDE.md — prisma migrate dev would attempt destructive
-- drift-correction against these raw-SQL CHECK constraints.

ALTER TABLE "scaling_events" DROP CONSTRAINT "scaling_events_scope_check";
ALTER TABLE "scaling_events" ADD CONSTRAINT "scaling_events_scope_check"
    CHECK ("scope" IN ('asg', 'ecs', 'rds', 'msk', 'elasticache', 'docdb'));

ALTER TABLE "scaling_events" DROP CONSTRAINT "scaling_events_scaling_type_check";
ALTER TABLE "scaling_events" ADD CONSTRAINT "scaling_events_scaling_type_check"
    CHECK ("scalingType" IN (
        'scheduled', 'target_tracking', 'step', 'simple', 'predictive', 'manual',
        'direct_api', 'storage_autoscaling',
        'health_check_replacement', 'capacity_rebalance', 'instance_refresh',
        'az_rebalance', 'max_instance_lifetime', 'not_scaled', 'unparsed'
    ));

ALTER TABLE "scaling_audit_coverage" DROP CONSTRAINT "scaling_audit_coverage_scope_check";
ALTER TABLE "scaling_audit_coverage" ADD CONSTRAINT "scaling_audit_coverage_scope_check"
    CHECK ("scope" IN ('asg', 'ecs', 'rds', 'msk', 'elasticache', 'docdb'));

ALTER TABLE "scaling_audit_watermarks" DROP CONSTRAINT "scaling_audit_watermarks_scope_check";
ALTER TABLE "scaling_audit_watermarks" ADD CONSTRAINT "scaling_audit_watermarks_scope_check"
    CHECK ("scope" IN ('asg', 'ecs', 'rds', 'msk', 'elasticache', 'docdb'));

ALTER TABLE "scaling_policy_snapshots" DROP CONSTRAINT "scaling_policy_snapshots_scope_check";
ALTER TABLE "scaling_policy_snapshots" ADD CONSTRAINT "scaling_policy_snapshots_scope_check"
    CHECK ("scope" IN ('asg', 'ecs', 'rds', 'msk', 'elasticache', 'docdb'));
