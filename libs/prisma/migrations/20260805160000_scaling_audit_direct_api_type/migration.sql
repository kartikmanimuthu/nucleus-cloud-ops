-- Add 'direct_api' as a scalingType (SA-002 correction).
--
-- WHY: the CloudTrail source originally recorded its rows as scalingType='manual'
-- and actorType='user', on the reasoning that userIdentity proves a human made
-- the call. That reasoning is WRONG. CloudTrail's AssumedRole covers humans and
-- machines alike. Measured in one live account over 7 days, the principals
-- issuing ecs:UpdateService were:
--
--     32  NucleusAccess-<hub>                     another Nucleus deployment's scheduler
--      8  secops-...-CodepipelineRole-...         CI/CD deployment pipelines
--      6  AWSReservedSSO_...                      actual humans
--      4  AWSServiceRoleForApplicationAutoScaling AWS itself (already filtered)
--
-- So 'manual' asserted human intent for CI/CD pipelines and another system's
-- automation. That is precisely the inference cause-classifier.ts is forbidden to
-- make ("never default to 'manual' — a mis-defaulted 'manual' reads as an
-- unauthorised change, which is itself an audit finding"). The CloudTrail source
-- broke that rule.
--
-- 'direct_api' describes the MECHANISM — a capacity change made by calling the
-- API directly, outside any scaling policy — without claiming anything about who.
-- The principal ARN in scaling_events.actor remains the actual evidence, and lets
-- a reader distinguish an SSO session from a pipeline role for themselves.
--
-- 'manual' is retained and unchanged: it still means what it always meant for the
-- ASG activity API, whose cause text literally says "a user request".
--
-- Hand-authored per CLAUDE.md — `prisma migrate dev` would attempt destructive
-- drift-correction against the raw-SQL CHECK constraints and triggers.

ALTER TABLE "scaling_events" DROP CONSTRAINT "scaling_events_scaling_type_check";
ALTER TABLE "scaling_events" ADD CONSTRAINT "scaling_events_scaling_type_check"
    CHECK ("scalingType" IN (
        'scheduled', 'target_tracking', 'step', 'simple', 'predictive', 'manual',
        'direct_api',
        'health_check_replacement', 'capacity_rebalance', 'instance_refresh',
        'az_rebalance', 'max_instance_lifetime', 'not_scaled', 'unparsed'
    ));

-- actorType is NOT changed. Its existing values already express what is needed:
--   'user'                      an identified human principal (IAMUser / Root)
--   'system'                    this platform acted (source='platform')
--   'unattributed_out_of_band'  a change from outside whose actor we cannot
--                               characterise — which is exactly an AssumedRole,
--                               where the ARN is known but human-vs-machine is not.
