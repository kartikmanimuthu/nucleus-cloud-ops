-- Add knowledgeBaseIds to agent_ops_runs and scheduled_tasks (mirrors mcpServerIds)
ALTER TABLE "agent_ops_runs" ADD COLUMN "knowledgeBaseIds" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "scheduled_tasks" ADD COLUMN "knowledgeBaseIds" TEXT[] NOT NULL DEFAULT '{}';
