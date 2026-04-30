# Graph Report - bug-fixes  (2026-04-30)

## Corpus Check
- 573 files · ~860,782 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1917 nodes · 2630 edges · 66 communities detected
- Extraction: 72% EXTRACTED · 28% INFERRED · 0% AMBIGUOUS · INFERRED: 745 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 110|Community 110]]
- [[_COMMUNITY_Community 113|Community 113]]
- [[_COMMUNITY_Community 114|Community 114]]

## God Nodes (most connected - your core abstractions)
1. `getSessionTenantId()` - 94 edges
2. `String()` - 91 edges
3. `getTenantClient()` - 76 edges
4. `getPrismaClient()` - 50 edges
5. `authorize()` - 41 edges
6. `getAuthSession()` - 34 edges
7. `toast()` - 24 edges
8. `processSchedule()` - 21 edges
9. `executeAgentRun()` - 20 edges
10. `POST()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `String()` --calls--> `ecsServicesDeep()`  [INFERRED]
  web-ui/components/audit/audit-client-component.tsx → workers/src/jobs/discovery/services/custom-scanners.ts
- `String()` --calls--> `wafv2Deep()`  [INFERRED]
  web-ui/components/audit/audit-client-component.tsx → workers/src/jobs/discovery/services/custom-scanners.ts
- `POST()` --calls--> `getEmbedding()`  [INFERRED]
  web-ui/app/api/knowledge-base/query/route.ts → workers/src/jobs/kb-sync/lib/embedding.ts
- `String()` --calls--> `verify()`  [INFERRED]
  web-ui/components/audit/audit-client-component.tsx → scripts/verify-migration.ts
- `String()` --calls--> `fetchStackOutputs()`  [INFERRED]
  web-ui/components/audit/audit-client-component.tsx → scripts/generate-env.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.02
Nodes (112): DELETE(), GET(), PUT(), GET(), POST(), GET(), defaultsToJson(), jsonToServerConfigs() (+104 more)

### Community 1 - "Community 1"
Cohesion: 0.04
Nodes (68): getPool(), handleAgentOpsTick(), loadActiveTasks(), queueName(), register(), writeAuditLog(), handleDiscoveryScan(), loadScanConfigs() (+60 more)

### Community 2 - "Community 2"
Cohesion: 0.03
Nodes (36): AccountPostgresRepository, generateEventSK(), generateNEventSKs(), AgentOpsEventPostgresRepository, freshTimestamp(), staleTimestamp(), classifyTool(), String() (+28 more)

### Community 3 - "Community 3"
Cohesion: 0.02
Nodes (35): handleAccountUpdated(), AccountsGrid(), getStatusIcon(), getStatusBadge(), toggleAccountStatus(), validateConnection(), handleSubmit(), validateConnection() (+27 more)

### Community 4 - "Community 4"
Cohesion: 0.03
Nodes (30): AgentOpsRunPostgresRepository, toAgentOpsRun(), PostgresChatHistory, GET(), getPrismaClient(), GET(), getCognitoClient(), getEmbedding() (+22 more)

### Community 5 - "Community 5"
Cohesion: 0.04
Nodes (48): formatMessageForAudit(), getActiveMCPTools(), getAuditDepth(), getStore(), llmAuditLog(), truncateOutput(), createDeepGraph(), createFastGraph() (+40 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (51): AccountsPage(), processASGResource(), processDocDBResource(), processEC2Resource(), extractClusterName(), extractServiceName(), getClusterASGs(), isClusterIdle() (+43 more)

### Community 7 - "Community 7"
Cohesion: 0.06
Nodes (43): deriveUserId(), executeAgentRun(), mapNodeToEventType(), processLangGraphEvent(), resumeApprovedRun(), buildAuthHeader(), postApprovalRequestToJira(), postApprovalResponseToJira() (+35 more)

### Community 8 - "Community 8"
Cohesion: 0.05
Nodes (29): createRun(), findAwaitingApprovalRun(), findAwaitingApprovalRunByJiraIssue(), findAwaitingRunByJiraIssue(), findAwaitingRunBySlackThread(), getRun(), getRunEvents(), listRuns() (+21 more)

### Community 9 - "Community 9"
Cohesion: 0.13
Nodes (16): appendMessage(), createThread(), deleteThread(), ensureIndexes(), getCollection(), getThread(), listThreads(), replaceMessages() (+8 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (13): adaptConfigForEnvironment(), extractDockerEnvVars(), extractDockerImage(), getMCPManager(), isCommandAvailable(), MCPServerManager, cleanupAllAgentProfiles(), createSessionProfile() (+5 more)

### Community 11 - "Community 11"
Cohesion: 0.1
Nodes (7): async(), handleFormSubmit(), handleKeyDown(), copyToClipboard(), exportToMarkdown(), extractMessageContent(), formatMessagesAsMarkdown()

### Community 12 - "Community 12"
Cohesion: 0.21
Nodes (16): appendMessage(), createThread(), deleteThread(), ensureIndexes(), getCollection(), getThread(), listThreads(), updateThread() (+8 more)

### Community 13 - "Community 13"
Cohesion: 0.19
Nodes (4): getAuditLogRepository(), GET(), AuditService, getRetentionDays()

### Community 14 - "Community 14"
Cohesion: 0.16
Nodes (4): getRequiredEnv(), HorizontalExecutor, sleep(), VerticalExecutor

### Community 15 - "Community 15"
Cohesion: 0.15
Nodes (9): AccountsLayout(), AgentLayout(), AuditLayout(), AuthorizePage(), checkPageAuth(), requireAuth(), can(), SchedulesLayout() (+1 more)

### Community 16 - "Community 16"
Cohesion: 0.17
Nodes (6): fetchAuditData(), handleRefresh(), loadMoreLogs(), handleNextPage(), handlePrevPage(), handleRefresh()

### Community 17 - "Community 17"
Cohesion: 0.22
Nodes (7): consumeStream(), createNewThread(), deleteThread(), fetchThreads(), handleApproval(), handleKeyDown(), handleSend()

### Community 18 - "Community 18"
Cohesion: 0.33
Nodes (2): getAccountRepository(), AccountService

### Community 19 - "Community 19"
Cohesion: 0.3
Nodes (2): getScheduleRepository(), ScheduleService

### Community 20 - "Community 20"
Cohesion: 0.3
Nodes (11): createScheduledTask(), deleteScheduledTask(), getScheduledTask(), listAllActiveTasks(), listScheduledTasks(), pauseScheduledTask(), resumeScheduledTask(), tryAcquireExecutionLock() (+3 more)

### Community 21 - "Community 21"
Cohesion: 0.29
Nodes (1): Logger

### Community 22 - "Community 22"
Cohesion: 0.24
Nodes (6): describeSchemaNode(), executeSQLNode(), executeReadOnlyQuery(), executeSchemaQuery(), getTextToSQLPool(), validateSQL()

### Community 23 - "Community 23"
Cohesion: 0.2
Nodes (7): generateSQLNode(), reflectNode(), synthesizeNode(), buildReflectionPrompt(), buildSQLGenerationPrompt(), buildSynthesisPrompt(), sanitizeFilterValue()

### Community 24 - "Community 24"
Cohesion: 0.22
Nodes (2): loadAccount(), validateConnection()

### Community 25 - "Community 25"
Cohesion: 0.29
Nodes (5): fetchConfig(), handleAddServer(), handleReset(), handleSave(), updateSummary()

### Community 26 - "Community 26"
Cohesion: 0.38
Nodes (1): FileSaver

### Community 27 - "Community 27"
Cohesion: 0.29
Nodes (5): buildTableEntries(), countPgTable(), padEnd(), padStart(), verify()

### Community 28 - "Community 28"
Cohesion: 0.25
Nodes (2): handleCreate(), resetForm()

### Community 29 - "Community 29"
Cohesion: 0.22
Nodes (1): ClientAccountService

### Community 30 - "Community 30"
Cohesion: 0.31
Nodes (6): chunkText(), embedAndStoreChunks(), forceChunk(), getBedrockClient(), getEmbedding(), recursiveSplit()

### Community 31 - "Community 31"
Cohesion: 0.25
Nodes (2): createScheduleViaAPI(), uniqueId()

### Community 32 - "Community 32"
Cohesion: 0.39
Nodes (5): handleDelete(), handlePause(), handleResume(), handleTrigger(), withAction()

### Community 33 - "Community 33"
Cohesion: 0.39
Nodes (5): handleDelete(), handlePause(), handleResume(), handleTrigger(), withBusy()

### Community 35 - "Community 35"
Cohesion: 0.25
Nodes (2): handleSubmit(), onSubmit()

### Community 36 - "Community 36"
Cohesion: 0.29
Nodes (2): getStatusBadge(), getStatusIcon()

### Community 37 - "Community 37"
Cohesion: 0.25
Nodes (1): ClientScheduleService

### Community 38 - "Community 38"
Cohesion: 0.43
Nodes (6): buildRunReportHtml(), esc(), exportRunToPdf(), formatDuration(), formatTime(), metaCard()

### Community 39 - "Community 39"
Cohesion: 0.36
Nodes (5): set(), fetchStackOutputs(), main(), mapOutputsToEnvVars(), writeEnvFile()

### Community 42 - "Community 42"
Cohesion: 0.29
Nodes (1): SafeMongoDBSaver

### Community 43 - "Community 43"
Cohesion: 0.57
Nodes (6): migrate(), migrateEvents(), migrateRuns(), migrateScheduledTasks(), scanAllItems(), ttlToDate()

### Community 44 - "Community 44"
Cohesion: 0.4
Nodes (3): NotFound(), generateMetadata(), Page()

### Community 46 - "Community 46"
Cohesion: 0.4
Nodes (2): loadAccounts(), refreshAccounts()

### Community 47 - "Community 47"
Cohesion: 0.53
Nodes (4): generateOnboardingTemplate(), generateOnboardingYaml(), GET(), POST()

### Community 49 - "Community 49"
Cohesion: 0.47
Nodes (3): handleSave(), hasAnyPermission(), toPermissionSet()

### Community 50 - "Community 50"
Cohesion: 0.6
Nodes (4): applyFilters(), buildFilters(), computeActiveFilters(), removeFilter()

### Community 51 - "Community 51"
Cohesion: 0.6
Nodes (4): downloadFile(), exportToCSV(), exportToJSON(), handleExport()

### Community 52 - "Community 52"
Cohesion: 0.4
Nodes (2): handleSync(), triggerSync()

### Community 54 - "Community 54"
Cohesion: 0.33
Nodes (1): ClientAuditService

### Community 55 - "Community 55"
Cohesion: 0.53
Nodes (4): formatExtra(), getConfiguredLevel(), log(), ts()

### Community 56 - "Community 56"
Cohesion: 0.53
Nodes (4): migrate(), migrateDataSources(), migrateKnowledgeBases(), queryDataSources()

### Community 57 - "Community 57"
Cohesion: 0.4
Nodes (2): main(), processBatch()

### Community 60 - "Community 60"
Cohesion: 0.6
Nodes (3): fetchKBs(), handleCreate(), handleDelete()

### Community 62 - "Community 62"
Cohesion: 0.4
Nodes (2): handleFileSelect(), fileToBase64()

### Community 63 - "Community 63"
Cohesion: 0.5
Nodes (2): handleImport(), processImport()

### Community 64 - "Community 64"
Cohesion: 0.5
Nodes (2): handleFollowUpClick(), handleSend()

### Community 67 - "Community 67"
Cohesion: 0.4
Nodes (1): ClientAuditService

### Community 69 - "Community 69"
Cohesion: 0.6
Nodes (3): main(), migrateAccounts(), migrateSchedules()

### Community 70 - "Community 70"
Cohesion: 0.6
Nodes (3): migrate(), migrateExecutions(), migrateSchedules()

### Community 84 - "Community 84"
Cohesion: 0.83
Nodes (3): notifyScheduledRunResult(), postToJiraIssue(), postToSlackChannel()

### Community 87 - "Community 87"
Cohesion: 0.83
Nodes (3): main(), migrateInventoryResources(), migrateVectorKeys()

### Community 88 - "Community 88"
Cohesion: 0.83
Nodes (3): ensureTenantExists(), migrate(), scanAllTenantConfigs()

### Community 89 - "Community 89"
Cohesion: 0.83
Nodes (3): isValidRole(), migrate(), scanAllRbacItems()

### Community 110 - "Community 110"
Cohesion: 1.0
Nodes (2): gotoAccounts(), gotoEditPage()

### Community 113 - "Community 113"
Cohesion: 1.0
Nodes (2): migrate(), queryAllAuditLogs()

### Community 114 - "Community 114"
Cohesion: 1.0
Nodes (2): migrate(), queryAllAccounts()

## Knowledge Gaps
- **Thin community `Community 18`** (12 nodes): `getAccountRepository()`, `AccountService`, `.createAccount()`, `.deleteAccount()`, `.getAccount()`, `.getAccounts()`, `.scanResources()`, `.toggleAccountStatus()`, `.updateAccount()`, `.validateAccount()`, `.validateCredentials()`, `account-service.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 19`** (12 nodes): `getScheduleRepository()`, `buildSchedulePK()`, `buildScheduleSK()`, `ScheduleService`, `.createSchedule()`, `.deleteSchedule()`, `.getSchedule()`, `.getSchedules()`, `.getSchedulesWithFilters()`, `.toggleScheduleStatus()`, `.updateSchedule()`, `schedule-service.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 21`** (12 nodes): `Logger`, `.child()`, `.clearContext()`, `.constructor()`, `.debug()`, `.error()`, `.formatMessage()`, `.info()`, `.setContext()`, `.setLevel()`, `.shouldLog()`, `.warn()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 24`** (10 nodes): `getStatusBadge()`, `getStatusIcon()`, `handleNextPage()`, `handlePrevPage()`, `loadAccount()`, `loadActivity()`, `loadResources()`, `loadSchedules()`, `validateConnection()`, `page.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 26`** (10 nodes): `FileSaver`, `.constructor()`, `.getCheckpointPath()`, `.getTuple()`, `.getWritesPath()`, `.hydrate()`, `.list()`, `.put()`, `.putWrites()`, `file-saver.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 28`** (9 nodes): `addModelField()`, `handleCreate()`, `handleDelete()`, `handleTest()`, `handleToggle()`, `removeModelField()`, `resetForm()`, `updateModelField()`, `provider-settings.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 29`** (9 nodes): `ClientAccountService`, `.createAccount()`, `.deleteAccount()`, `.getAccount()`, `.getAccounts()`, `.scanResources()`, `.updateAccount()`, `.validateAccount()`, `client-account-service.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 31`** (9 nodes): `applySearch()`, `clearFilters()`, `createScheduleViaAPI()`, `deleteScheduleViaAPI()`, `getScheduleViaAPI()`, `gotoSchedules()`, `switchToTableView()`, `uniqueId()`, `schedules.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 35`** (8 nodes): `handleOpenChange()`, `handleSubmit()`, `fetchSettings()`, `getOrgInitial()`, `handleLogoUpload()`, `onSubmit()`, `invite-member-dialog.tsx`, `organization-settings-form.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 36`** (8 nodes): `copyToClipboard()`, `formatTimestamp()`, `getSeverityBadge()`, `getStatusBadge()`, `getStatusIcon()`, `getUserTypeIcon()`, `viewCorrelatedEvents()`, `audit-logs-table.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 37`** (8 nodes): `ClientScheduleService`, `.createSchedule()`, `.deleteSchedule()`, `.getSchedule()`, `.getSchedules()`, `.toggleScheduleStatus()`, `.updateSchedule()`, `client-schedule-service.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 42`** (7 nodes): `SafeMongoDBSaver`, `.constructor()`, `.getTuple()`, `.list()`, `.put()`, `.putWrites()`, `safe-mongo-saver.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 46`** (6 nodes): `exportAccounts()`, `handleSelectAccount()`, `handleSelectAll()`, `loadAccounts()`, `refreshAccounts()`, `page-updated.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 52`** (6 nodes): `handleClose()`, `handleSync()`, `toggle()`, `toggleAll()`, `triggerSync()`, `sync-accounts-dialog.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 54`** (6 nodes): `ClientAuditService`, `.getAuditLogs()`, `.getAuditLogsByCorrelationId()`, `.getAuditLogStats()`, `.logUserAction()`, `client-audit-service-api.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 57`** (6 nodes): `computeContentHash()`, `createResourceText()`, `getEmbedding()`, `main()`, `processBatch()`, `backfill-embeddings.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 62`** (5 nodes): `handleFileSelect()`, `removeFile()`, `fileToBase64()`, `file-upload.tsx`, `file-upload.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 63`** (5 nodes): `handleFileSelect()`, `handleImport()`, `handleJsonValidation()`, `processImport()`, `import-accounts-dialog.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 64`** (5 nodes): `filters()`, `handleClearConversation()`, `handleFollowUpClick()`, `handleSend()`, `ask-ai-dialog.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 67`** (5 nodes): `ClientAuditService`, `.getAuditLogs()`, `.getAuditLogStats()`, `.logUserAction()`, `client-audit-service.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 110`** (3 nodes): `gotoAccounts()`, `gotoEditPage()`, `accounts.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 113`** (3 nodes): `migrate()`, `queryAllAuditLogs()`, `migrate-audit-logs.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 114`** (3 nodes): `migrate()`, `queryAllAccounts()`, `migrate-accounts.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `String()` connect `Community 2` to `Community 0`, `Community 1`, `Community 3`, `Community 4`, `Community 5`, `Community 38`, `Community 7`, `Community 39`, `Community 6`, `Community 14`, `Community 16`, `Community 21`, `Community 22`, `Community 27`?**
  _High betweenness centrality (0.215) - this node is a cross-community bridge._
- **Why does `getSessionTenantId()` connect `Community 0` to `Community 2`, `Community 4`, `Community 5`, `Community 7`, `Community 8`, `Community 13`?**
  _High betweenness centrality (0.109) - this node is a cross-community bridge._
- **Why does `loadSchedules()` connect `Community 3` to `Community 2`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Are the 93 inferred relationships involving `getSessionTenantId()` (e.g. with `GET()` and `GET()`) actually correct?**
  _`getSessionTenantId()` has 93 INFERRED edges - model-reasoned connections that need verification._
- **Are the 90 inferred relationships involving `String()` (e.g. with `AuditPage()` and `POST()`) actually correct?**
  _`String()` has 90 INFERRED edges - model-reasoned connections that need verification._
- **Are the 74 inferred relationships involving `getTenantClient()` (e.g. with `GET()` and `PATCH()`) actually correct?**
  _`getTenantClient()` has 74 INFERRED edges - model-reasoned connections that need verification._
- **Are the 48 inferred relationships involving `getPrismaClient()` (e.g. with `POST()` and `GET()`) actually correct?**
  _`getPrismaClient()` has 48 INFERRED edges - model-reasoned connections that need verification._