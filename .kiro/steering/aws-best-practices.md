---
inclusion: always
name: aws-best-practices
description: AWS-specific best practices for Nucleus Cloud Ops development
---

# AWS Best Practices for Nucleus Cloud Ops

## Security & IAM

### Cross-Account Access
- **ALWAYS** use `sts:AssumeRole` for cross-account operations — never hardcode credentials
- Implement least-privilege IAM policies — grant only required permissions
- Use session tags for audit trail: `RoleSessionName` should include user/agent context
- Set maximum session duration to 1 hour for agent operations

### Secrets Management
- Store API keys in AWS Secrets Manager or SSM Parameter Store (encrypted)
- Never commit secrets to git — use `.env.local` (gitignored)
- Rotate Bedrock API keys quarterly
- Use IAM roles for ECS tasks instead of access keys

## DynamoDB Patterns

### Single-Table Design
- Follow existing schema in `docs/schema-design.md` — don't create new tables
- Use composite keys: `PK` (partition key) and `SK` (sort key)
- Add GSIs only after consulting existing indexes
- Enable point-in-time recovery for production tables

### Query Optimization
- Use `KeyConditionExpression` over `FilterExpression` when possible
- Batch operations: `BatchGetItem` (max 100), `BatchWriteItem` (max 25)
- Implement exponential backoff for `ProvisionedThroughputExceededException`
- Use `ProjectionExpression` to fetch only required attributes

### Audit Logging
- Every AWS resource modification MUST write to `DYNAMODB_AUDIT_TABLE_NAME`
- Include: `userId`, `action`, `resourceType`, `accountId`, `timestamp`, `result`
- TTL set to 30 days (`expiresAt` attribute)

## Lambda Best Practices

### Scheduler Lambda
- Timeout: 5 minutes max (EventBridge limit: 15 min)
- Memory: 512 MB minimum for AWS SDK operations
- Environment variables: use SSM Parameter Store for dynamic config
- Error handling: catch `AssumeRole` failures and log to CloudWatch

### Cold Start Optimization
- Keep deployment package < 50 MB
- Use Lambda layers for shared dependencies (AWS SDK v3)
- Implement connection pooling for DynamoDB client
- Lazy-load heavy modules (e.g., LangGraph)

## AI Agent (LangGraph + Bedrock)

### Bedrock Configuration
- Model: `anthropic.claude-3-5-sonnet-20241022-v2:0`
- Max tokens: 4096 for responses, 200k context window
- Temperature: 0.7 for creative tasks, 0.1 for structured ops
- Streaming: enabled for chat UI (`streamEvents`)

### Tool Execution
- Timeout: 30s per tool call (AWS SDK operations)
- Retry logic: 3 attempts with exponential backoff
- Validation: use Zod schemas for tool inputs
- Audit: log every tool invocation to DynamoDB

### Checkpoint Management
- Store in `DYNAMODB_CHECKPOINT_TABLE` with TTL (7 days)
- Use thread IDs for conversation continuity
- Implement checkpoint pruning for long conversations (> 50 turns)

### Multimodal Support
- Max image size: 5 MB (Bedrock limit: 20 MB)
- Supported formats: PNG, JPEG, WebP, GIF
- Resize images > 5 MB before sending to Bedrock
- Store image metadata in audit log (size, format, S3 key if uploaded)

## CDK Infrastructure

### Stack Organization
- **Never modify** `computeStack.ts` or `networkingStack.ts` without `cdk diff`
- Use stack outputs for cross-stack references
- Tag all resources: `Project: nucleus-ops`, `Environment: prod|dev`
- Enable CloudFormation drift detection

### Deployment Safety
- Run `cdk synth` before `cdk deploy` to catch errors
- Use `--require-approval` flag for production deployments
- Implement blue-green deployments for ECS services
- Set up CloudWatch alarms for critical metrics

### Cost Optimization
- Use ECS Fargate Spot for non-critical workloads
- Enable DynamoDB auto-scaling (target utilization: 70%)
- Set CloudWatch Logs retention to 7 days for dev, 30 days for prod
- Use S3 Intelligent-Tiering for uploaded images

## API Development (Next.js)

### AWS SDK v3 Usage
```typescript
// ✅ Correct
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
const client = new DynamoDBClient({ region: process.env.AWS_REGION });

// ❌ Wrong
import AWS from 'aws-sdk'; // SDK v2 — deprecated
```

### Error Handling
- Catch AWS SDK errors by type: `ResourceNotFoundException`, `AccessDeniedException`
- Return structured errors: `{ error: string, code: string, details?: any }`
- Log errors to CloudWatch with context (user, action, resource)

### Rate Limiting
- Implement token bucket for Bedrock API calls (10 req/sec per account)
- Use Redis for distributed rate limiting (ElastiCache)
- Return `429 Too Many Requests` with `Retry-After` header

## Monitoring & Observability

### CloudWatch Metrics
- Custom metrics: `ScheduleExecutionSuccess`, `ScheduleExecutionFailure`
- Dimensions: `AccountId`, `ResourceType`, `ScheduleId`
- Alarms: Lambda errors > 5 in 5 min, DynamoDB throttles > 10 in 1 min

### Logging Standards
```typescript
// Structured logging
console.log(JSON.stringify({
  level: 'info',
  message: 'Schedule executed',
  scheduleId: 'sch-123',
  accountId: 'acc-456',
  resourceCount: 5,
  duration: 1234
}));
```

### X-Ray Tracing
- Enable for Lambda functions and API Gateway
- Annotate traces with custom metadata: `userId`, `scheduleId`
- Use subsegments for AWS SDK calls

## Testing

### Unit Tests
- Mock AWS SDK clients using `aws-sdk-client-mock`
- Test IAM policy logic with `iam-policy-simulator`
- Validate DynamoDB queries with local DynamoDB

### Integration Tests
- Use separate AWS account for testing
- Clean up resources after tests (CloudFormation stacks)
- Test cross-account AssumeRole with test IAM roles

## Git Workflow

- Main branch: `master` (protected)
- Feature branches: `feature/<name>`, `fix/<name>`, `agent/<name>`
- Active work: `agent-ops-implementation` branch
- Commit messages: conventional commits (`feat:`, `fix:`, `chore:`)

## Documentation

- Update `docs/ARCHITECTURE.md` for infrastructure changes
- Update `docs/schema-design.md` for DynamoDB schema changes
- Add screenshots to `docs/screenshots/` for UI changes
- Keep `README.md` in sync with features
