-- Agent Ops gained a third execution mode, 'deep' (the deepagents framework
-- graph), alongside 'plan'. These CHECK constraints were written in
-- 20260328060046_phase04_kb_inventory_agent_ops when plan/fast were the only
-- modes and the event vocabulary had no sub-agent or to-do concepts, so every
-- deep run failed at INSERT with 23514.
--
-- Prisma models these columns as plain String, so nothing in schema.prisma
-- signals these constraints exist — they live only in migration SQL.

-- A run may now execute in deep mode.
ALTER TABLE "agent_ops_runs" DROP CONSTRAINT IF EXISTS "agent_ops_runs_mode_check";
ALTER TABLE "agent_ops_runs" ADD CONSTRAINT "agent_ops_runs_mode_check"
    CHECK (mode = ANY (ARRAY['plan'::text, 'fast'::text, 'deep'::text]));

-- A scheduled task may be saved as deep, so its cron-triggered runs are deep.
ALTER TABLE "scheduled_tasks" DROP CONSTRAINT IF EXISTS "scheduled_tasks_mode_check";
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_mode_check"
    CHECK (mode = ANY (ARRAY['plan'::text, 'fast'::text, 'deep'::text]));

-- Deep runs emit two event types the plan graph never produced: 'todo' (the
-- write_todos checklist) and 'subagent' (sub-agent lifecycle). Both are
-- load-bearing for the run timeline and the markdown export.
ALTER TABLE "agent_ops_events" DROP CONSTRAINT IF EXISTS "agent_ops_events_event_type_check";
ALTER TABLE "agent_ops_events" ADD CONSTRAINT "agent_ops_events_event_type_check"
    CHECK ("eventType" = ANY (ARRAY[
        'planning'::text, 'execution'::text, 'tool_call'::text, 'tool_result'::text,
        'reflection'::text, 'revision'::text, 'final'::text, 'error'::text,
        'memory_recall'::text, 'memory_save'::text, 'evaluation'::text,
        'notification'::text, 'todo'::text, 'subagent'::text
    ]));
