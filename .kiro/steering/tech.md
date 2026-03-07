# Technology Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 15, React 19, Tailwind CSS, Radix UI |
| AI Agent | LangGraph, LangChain, AWS Bedrock (Claude 4.5 Sonnet), MCP |
| Infrastructure | AWS CDK v2, ECS Fargate, CloudFront, DynamoDB |
| Auth | NextAuth.js |
| Testing | Vitest (web-ui), Jest (CDK) |

## Coding Conventions

- **TypeScript everywhere**, strict mode enabled
- **React**: functional components + hooks only, no class components
- **Styling**: Radix UI primitives + Tailwind CSS utility classes
- **AWS**: SDK v3 only (`@aws-sdk/client-*`) — never SDK v2
- **Agent**: LangGraph `StateGraph` for all agent workflows
- **API**: Next.js API routes in `web-ui/app/api/`
- **DynamoDB single-table design** — consult `docs/schema-design.md` before adding entities.

## Key Constraints

- **DO NOT** modify `lib/computeStack.ts` or `lib/networkingStack.ts` without running `cdk diff` first.
- **Never hardcode AWS credentials** — all cross-account ops use STS AssumeRole.
- **Git**: main branch is `master`; active feature work on `agent-ops-implementation`.
- **Audit log** every action that modifies AWS resources (existing pattern in `lib/agent/`).
