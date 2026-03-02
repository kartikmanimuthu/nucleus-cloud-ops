# Nucleus Cloud Ops

AWS Cloud Operations Platform — multi-account resource scheduling + AI Ops agent powered by AWS Bedrock.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 15, React 19, Tailwind CSS, Radix UI |
| AI Agent | LangGraph, LangChain, AWS Bedrock (Claude 4.5 Sonnet), MCP |
| Infrastructure | AWS CDK v2, ECS Fargate, CloudFront, DynamoDB |
| Auth | NextAuth.js |
| Testing | Vitest (web-ui), Jest (CDK) |

## Key Commands

```bash
# Local development
cd web-ui && npm run dev        # Next.js dev server → http://localhost:3000

# Testing
cd web-ui && npm run test       # Vitest (web-ui)
npm test                        # Jest (CDK stacks)

# Linting
cd web-ui && npm run lint       # ESLint for web-ui

# Build
cd web-ui && npm run build      # Next.js production build
npm run build                   # Compile CDK TypeScript

# Deploy
npx cdk deploy WebUIStack --profile <profile>   # Deploy web UI stack
npx cdk deploy --all --profile <profile>        # Deploy all stacks
```

## Environment Setup

```bash
# 1. Install dependencies
npm install
cd web-ui && npm install

# 2. Configure environment
cp web-ui/.env.local.example web-ui/.env.local
# Required vars: AWS_REGION, DYNAMODB_TABLE_NAME, DYNAMODB_AUDIT_TABLE_NAME, NEXTAUTH_SECRET
# Optional (AI agent): DYNAMODB_CHECKPOINT_TABLE, DYNAMODB_WRITES_TABLE, TAVILY_API_KEY

# 3. AWS credentials
export AWS_PROFILE=your-profile   # or configure ~/.aws/credentials
```

## Project Structure

```
nucleus-cloud-ops/
├── web-ui/
│   ├── app/              # Next.js app router (pages + API routes)
│   ├── components/       # React UI components
│   │   └── agent/        # Agent-specific UI (chat, ops panel)
│   ├── lib/
│   │   ├── agent/        # AI agent implementation (LangGraph)
│   │   │   ├── fast-agent.ts       # Quick response agent
│   │   │   ├── planning-agent.ts   # Multi-step planning agent
│   │   │   └── agent-shared.ts     # Shared tools, prompts, state
│   │   └── ...           # AWS clients, DynamoDB helpers, utilities
│   └── hooks/            # Custom React hooks
├── lib/                  # CDK stack definitions
│   ├── computeStack.ts   # ECS, ALB, CloudFront
│   ├── networkingStack.ts # VPC, subnets
│   └── webUIStack.ts     # Web UI deployment
├── lambda/               # Lambda functions (scheduler, discovery, vector)
├── bin/                  # CDK app entry point
├── docs/                 # Architecture, schema design, PRD
└── test/                 # CDK Jest tests
```

## Coding Conventions

- **TypeScript everywhere**, strict mode enabled
- **React**: functional components + hooks only, no class components
- **Styling**: Radix UI primitives + Tailwind CSS utility classes
- **AWS**: SDK v3 only (`@aws-sdk/client-*`) — never SDK v2
- **Agent**: LangGraph `StateGraph` for all agent workflows
- **API**: Next.js API routes in `web-ui/app/api/`

## Agent Architecture

The AI agent lives in `web-ui/lib/agent/`. Key patterns:
- Tools are defined with `DynamicStructuredTool` from LangChain
- Agent state uses LangGraph `Annotation` for type-safe state management
- Cross-account AWS calls always go through `sts:AssumeRole`
- Checkpoints stored in DynamoDB (`DYNAMODB_CHECKPOINT_TABLE`)

## Constraints

- **DO NOT** modify `lib/computeStack.ts` or `lib/networkingStack.ts` without running `cdk diff` first
- **DynamoDB single-table design** — consult `docs/schema-design.md` before adding entities
- **Never hardcode AWS credentials** — all cross-account ops use STS AssumeRole
- **Git**: main branch is `master`; active feature work on `agent-ops-implementation`
- **Audit log** every action that modifies AWS resources (existing pattern in `lib/agent/`)
