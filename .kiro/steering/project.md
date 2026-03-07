---
inclusion: always
name: project
description: Project context and conventions for Nucleus Cloud Ops
---

# Project: Nucleus Cloud Ops

AWS multi-account resource scheduling platform with AI Ops agent.

## Stack

- Next.js 15 / React 19 / Tailwind / Radix UI
- AWS CDK v2 (TypeScript) — ECS Fargate, Lambda, DynamoDB, CloudFront
- LangGraph + AWS Bedrock (Claude 4.5 Sonnet) for AI agent
- NextAuth.js for auth

## Structure

- `web-ui/` — Next.js app (pages, components, API routes, agent logic)
- `lib/` — CDK stacks (`computeStack.ts`, `networkingStack.ts`, `webUIStack.ts`)
- `lambda/` — Lambda functions (scheduler)
- `docs/` — Architecture, schema design, PRD

## Conventions

- TypeScript strict mode everywhere
- AWS SDK v3 only (`@aws-sdk/client-*`) — never v2
- Cross-account ops via `sts:AssumeRole` — never hardcode credentials
- DynamoDB single-table design — check `docs/schema-design.md` before adding entities
- Audit log every AWS resource modification to `DYNAMODB_AUDIT_TABLE_NAME`
- Functional React components + hooks only
- Styling: Radix UI + Tailwind utilities

## Guardrails

- Don't modify `lib/computeStack.ts` or `lib/networkingStack.ts` without `cdk diff` first
- Main branch: `master`. Feature work: `agent-ops-implementation`
- Lambda: 5 min timeout max, 512 MB memory min
- Bedrock model: `anthropic.claude-3-5-sonnet-20241022-v2:0`, streaming enabled
- Checkpoints in `DYNAMODB_CHECKPOINT_TABLE` with 7-day TTL
- Max image size for multimodal: 5 MB (PNG, JPEG, WebP, GIF)

## AWS Patterns

- DynamoDB: composite keys (PK + SK), `KeyConditionExpression` over `FilterExpression`, `ProjectionExpression` for sparse reads
- Lambda: layers for shared deps, exponential backoff for throttles, structured JSON logging
- CDK: tag all resources `Project: nucleus-ops`, use stack outputs for cross-stack refs
- Bedrock: temperature 0.7 creative / 0.1 structured, 4096 max tokens, tool timeout 30s with 3 retries
