import { executeAgentRun } from '../lib/agent-ops/agent-executor';

async function main() {
    const run = {
        runId: 'test-run-123',
        tenantId: 'default',
        taskDescription: 'Find pending ec2 approval rules',
        workspaceId: 'default',
        mcpServerIds: []
    } as any;
    
    console.log("Running agent test...");
    await executeAgentRun(run);
    console.log("Test finished!");
}

main().catch(console.error);
