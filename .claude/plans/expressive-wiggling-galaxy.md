# Fix: Reflector Node Missing Tool Call Context

## Context

The fast agent's reflection pattern causes a destructive loop where the reflector accuses the agent of "hallucinating" data that was actually retrieved via real tool calls. This happens because the reflector receives **only** the user query and agent's text response — it has zero visibility into tool calls or their results.

**What happens:**
1. Agent calls tools (e.g., `jira_search`), gets real data, generates a text response with that data
2. Reflector sees only the text response — no evidence of tool execution
3. Reflector says "you're fabricating data, no tool call was executed"
4. Agent tries to defend itself or re-calls tools
5. Reflector still can't see tool results → loop repeats for ~10 iterations burning tokens and time

## Root Cause

`web-ui/lib/agent/fast-agent.ts` — `reflectNode()` (lines 198-209):

```typescript
const critiqueInput = new HumanMessage({
    content: `<USER_QUERY>${originalQuery}</USER_QUERY>
<ASSISTANT_RESPONSE>${agentResponse}</ASSISTANT_RESPONSE>`
});
```

Only `originalQuery` and `agentResponse` are passed. The `state.toolResults` array (which `collectingToolNode` populates) is never read by the reflector.

## Fix

**File:** `web-ui/lib/agent/fast-agent.ts` — `reflectNode()` function

1. **Read `state.toolResults`** in `reflectNode` and format them into a `<TOOL_EXECUTION_LOG>` section
2. **Include the tool log** in the `critiqueInput` HumanMessage, between `<USER_QUERY>` and `<ASSISTANT_RESPONSE>`
3. **Update the reflector system prompt** to acknowledge that tool execution evidence will be provided and should be trusted

### Detailed changes:

In `reflectNode` (around line 146), after extracting `messages`:

```typescript
// Build tool execution summary from state
const { toolResults } = state;
let toolExecutionLog = '';
if (toolResults && toolResults.length > 0) {
    const entries = toolResults.map(tr =>
        `- ${tr.toolName} (iteration ${tr.iterationIndex}): ${tr.isError ? 'ERROR' : 'OK'}\n  Output: ${tr.output}`
    ).join('\n');
    toolExecutionLog = `\n<TOOL_EXECUTION_LOG>\nThe following tools were executed during this conversation:\n${entries}\n</TOOL_EXECUTION_LOG>\n`;
}
```

In the `critiqueInput` HumanMessage (around line 198):

```typescript
const critiqueInput = new HumanMessage({
    content: `Here is the interaction to review:

<USER_QUERY>
${originalQuery}
</USER_QUERY>
${toolExecutionLog}
<ASSISTANT_RESPONSE>
${agentResponse}
</ASSISTANT_RESPONSE>

Please provide your critique.`
});
```

In the reflector system prompt (around line 163), add a note:

```
If a <TOOL_EXECUTION_LOG> section is present, it contains verified tool calls and their outputs that the assistant executed. Use this as ground truth when evaluating correctness — do not claim the assistant fabricated data if the tool log confirms the data was retrieved.
```

## Verification

1. Run `cd web-ui && npm run build` to ensure no type errors
2. Start dev server: `cd web-ui && npm run dev`
3. Open the agent chat, select a skill with MCP tools (e.g., Jira), and ask a question that requires tool calls
4. Verify in backend logs:
   - Reflector critique should reference tool execution log
   - No more "hallucination" accusations when agent presents real tool data
   - Reflection loop should resolve in 1-2 iterations instead of 5-10
5. Run tests: `cd web-ui && npm run test`
