-- Re-sync agent_ops CHECK constraints with the code's value sets.
-- The 2026-03-28 migration froze these lists; the code has since added:
--   eventType: memory_recall / memory_save / evaluation (run-timeline redesign)
--              and notification (scheduled digest delivery marker)
--   source:    telegram / discord / webhook (gateway channel adapters)
-- Every INSERT with a new value fails 23514 and is swallowed by the repository's
-- try/catch, so memory/evaluation/notification timeline events were silently
-- dropped, and a telegram/discord/webhook-triggered run cannot be created.
-- Keep in sync with AgentEventType and TriggerSource in
-- apps/web-ui/lib/agent-ops/types.ts.

ALTER TABLE "agent_ops_events" DROP CONSTRAINT "agent_ops_events_event_type_check";
ALTER TABLE "agent_ops_events" ADD CONSTRAINT "agent_ops_events_event_type_check"
    CHECK ("eventType" IN (
        'planning', 'execution', 'tool_call', 'tool_result', 'reflection',
        'revision', 'final', 'error',
        'memory_recall', 'memory_save', 'evaluation', 'notification'
    ));

ALTER TABLE "agent_ops_runs" DROP CONSTRAINT "agent_ops_runs_source_check";
ALTER TABLE "agent_ops_runs" ADD CONSTRAINT "agent_ops_runs_source_check"
    CHECK ("source" IN ('slack', 'jira', 'discord', 'telegram', 'webhook', 'api', 'scheduled'));
