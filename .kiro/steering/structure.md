# Project Structure

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
