# Nucleus Cloud Ops

AWS Cloud Operations Platform — multi-account resource scheduling + AI Ops agent powered by AWS Bedrock.

## Core Features
- Multi-account resource scheduling.
- AI Ops agent powered by AWS Bedrock (Claude 4.5 Sonnet).
- LangGraph-based agent workflows (fast-agent, planning-agent).

## Agent Architecture
- Tools are defined with `DynamicStructuredTool` from LangChain.
- Agent state uses LangGraph `Annotation` for type-safe state management.
- Cross-account AWS calls always go through `sts:AssumeRole`.
- Checkpoints stored in DynamoDB (`DYNAMODB_CHECKPOINT_TABLE`).
