# Graph Report - workers/src/jobs/scheduler  (2026-04-30)

## Corpus Check
- Corpus is ~14,190 words - fits in a single context window. You may not need a graph.

## Summary
- 93 nodes · 198 edges · 7 communities detected
- Extraction: 83% EXTRACTED · 17% INFERRED · 0% AMBIGUOUS · INFERRED: 33 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Resource Schedulers|Resource Schedulers]]
- [[_COMMUNITY_DynamoDB Service|DynamoDB Service]]
- [[_COMMUNITY_Job Handler & Tests|Job Handler & Tests]]
- [[_COMMUNITY_Logging Utilities|Logging Utilities]]
- [[_COMMUNITY_PostgreSQL Service|PostgreSQL Service]]
- [[_COMMUNITY_Execution History|Execution History]]
- [[_COMMUNITY_ECS Scheduler|ECS Scheduler]]

## God Nodes (most connected - your core abstractions)
1. `processSchedule()` - 20 edges
2. `Logger` - 12 edges
3. `getPool()` - 11 edges
4. `getDynamoDBClient()` - 9 edges
5. `createAuditLog()` - 9 edges
6. `processECSResource()` - 7 edges
7. `runFullScan()` - 7 edges
8. `runPartialScan()` - 7 edges
9. `getExecutionHistory()` - 7 edges
10. `createExecutionRecord()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `processSchedule()` --calls--> `isCurrentTimeInRange()`  [INFERRED]
  services/scheduler-service.ts → utils/time-utils.ts
- `createExecutionRecord()` --calls--> `calculateTTL()`  [INFERRED]
  services/execution-history-service.ts → utils/time-utils.ts
- `processRDSResource()` --calls--> `createAuditLog()`  [INFERRED]
  resource-schedulers/rds-scheduler.ts → services/pg-service.ts
- `processSchedule()` --calls--> `processRDSResource()`  [INFERRED]
  services/scheduler-service.ts → resource-schedulers/rds-scheduler.ts
- `processASGResource()` --calls--> `createAuditLog()`  [INFERRED]
  resource-schedulers/asg-scheduler.ts → services/pg-service.ts

## Communities

### Community 0 - "Resource Schedulers"
Cohesion: 0.13
Nodes (6): processASGResource(), processDocDBResource(), processEC2Resource(), processRDSResource(), assumeRole(), getSTSClient()

### Community 1 - "DynamoDB Service"
Cohesion: 0.19
Nodes (9): createAuditLog(), createExecutionAuditLog(), fetchActiveAccounts(), fetchActiveSchedules(), fetchScheduleById(), getDynamoDBClient(), getRecentExecutions(), calculateTTL() (+1 more)

### Community 2 - "Job Handler & Tests"
Cohesion: 0.2
Nodes (10): handleSchedulerJob(), createAuditLog(), createResult(), extractAccountIdFromArn(), extractRegionFromArn(), groupResourcesByAccount(), groupResourcesByRegion(), runFullScan() (+2 more)

### Community 3 - "Logging Utilities"
Cohesion: 0.29
Nodes (1): Logger

### Community 4 - "PostgreSQL Service"
Cohesion: 0.3
Nodes (10): getAccounts(), getActiveTenants(), getExecutionHistory(), getPool(), getScheduleById(), getSchedules(), getTenantJobConfig(), getTenantSchedulerConfig() (+2 more)

### Community 5 - "Execution History"
Cohesion: 0.44
Nodes (10): buildExecutionPK(), buildExecutionSK(), createExecutionRecord(), getExecutionHistory(), getLastASGState(), getLastEC2InstanceState(), getLastECSServiceState(), getLastRDSInstanceState() (+2 more)

### Community 6 - "ECS Scheduler"
Cohesion: 0.39
Nodes (7): extractClusterName(), extractServiceName(), getClusterASGs(), isClusterIdle(), listAllContainerInstances(), listAllServiceArns(), processECSResource()

## Knowledge Gaps
- **Thin community `Logging Utilities`** (12 nodes): `Logger`, `.child()`, `.clearContext()`, `.constructor()`, `.debug()`, `.error()`, `.formatMessage()`, `.info()`, `.setContext()`, `.setLevel()`, `.shouldLog()`, `.warn()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Logger` connect `Logging Utilities` to `Resource Schedulers`?**
  _High betweenness centrality (0.223) - this node is a cross-community bridge._
- **Why does `processSchedule()` connect `Execution History` to `Resource Schedulers`, `DynamoDB Service`, `Job Handler & Tests`, `ECS Scheduler`?**
  _High betweenness centrality (0.122) - this node is a cross-community bridge._
- **Why does `processECSResource()` connect `ECS Scheduler` to `Job Handler & Tests`, `Execution History`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Are the 14 inferred relationships involving `processSchedule()` (e.g. with `isCurrentTimeInRange()` and `assumeRole()`) actually correct?**
  _`processSchedule()` has 14 INFERRED edges - model-reasoned connections that need verification._
- **Are the 4 inferred relationships involving `getDynamoDBClient()` (e.g. with `createExecutionRecord()` and `updateExecutionRecord()`) actually correct?**
  _`getDynamoDBClient()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **Are the 7 inferred relationships involving `createAuditLog()` (e.g. with `processRDSResource()` and `processASGResource()`) actually correct?**
  _`createAuditLog()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Should `Resource Schedulers` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._