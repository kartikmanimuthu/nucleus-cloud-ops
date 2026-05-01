# Graph Report - data-time-format  (2026-05-01)

## Corpus Check
- 574 files · ~861,584 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1918 nodes · 2597 edges · 63 communities detected
- Extraction: 71% EXTRACTED · 29% INFERRED · 0% AMBIGUOUS · INFERRED: 755 edges (avg confidence: 0.8)
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
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 104|Community 104]]
- [[_COMMUNITY_Community 107|Community 107]]
- [[_COMMUNITY_Community 108|Community 108]]

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
- `executeScheduleNow()` --calls--> `toast()`  [INFERRED]
  web-ui/app/app/schedules/[scheduleId]/page.tsx → /Users/kartik/.superset/worktrees/nucleus-cloud-ops/bug-fixes/web-ui/hooks/use-toast.ts
- `toggleScheduleStatus()` --calls--> `toast()`  [INFERRED]
  web-ui/components/schedules/schedules-grid.tsx → /Users/kartik/.superset/worktrees/nucleus-cloud-ops/bug-fixes/web-ui/hooks/use-toast.ts
- `toggleScheduleStatus()` --calls--> `toast()`  [INFERRED]
  web-ui/components/schedules/schedules-table.tsx → /Users/kartik/.superset/worktrees/nucleus-cloud-ops/bug-fixes/web-ui/hooks/use-toast.ts
- `executeScheduleNow()` --calls--> `toast()`  [INFERRED]
  web-ui/components/schedules/schedules-table.tsx → /Users/kartik/.superset/worktrees/nucleus-cloud-ops/bug-fixes/web-ui/hooks/use-toast.ts
- `String()` --calls--> `esc()`  [INFERRED]
  /Users/kartik/.superset/worktrees/nucleus-cloud-ops/bug-fixes/web-ui/components/audit/audit-client-component.tsx → web-ui/lib/agent-ops/export-pdf.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.02
Nodes (112): DELETE(), GET(), PUT(), GET(), POST(), GET(), defaultsToJson(), jsonToServerConfigs() (+104 more)

### Community 1 - "Community 1"
Cohesion: 0.03
Nodes (34): AccountPostgresRepository, generateEventSK(), generateNEventSKs(), AgentOpsEventPostgresRepository, freshTimestamp(), staleTimestamp(), classifyTool(), String() (+26 more)

### Community 2 - "Community 2"
Cohesion: 0.04
Nodes (63): handleDiscoveryScan(), loadScanConfigs(), periodToMs(), shouldRunTenant(), main(), parseArgs(), bbListRepoFiles(), bbListWorkspaceRepos() (+55 more)

### Community 3 - "Community 3"
Cohesion: 0.02
Nodes (35): handleAccountUpdated(), AccountsGrid(), getStatusIcon(), getStatusBadge(), toggleAccountStatus(), validateConnection(), handleSubmit(), validateConnection() (+27 more)

### Community 4 - "Community 4"
Cohesion: 0.03
Nodes (27): AgentOpsRunPostgresRepository, toAgentOpsRun(), PostgresChatHistory, GET(), getPrismaClient(), GET(), getCognitoClient(), InvitationService (+19 more)

### Community 5 - "Community 5"
Cohesion: 0.04
Nodes (56): adaptConfigForEnvironment(), extractDockerEnvVars(), extractDockerImage(), getMCPManager(), isCommandAvailable(), MCPServerManager, deriveUserId(), executeAgentRun() (+48 more)

### Community 6 - "Community 6"
Cohesion: 0.04
Nodes (42): createRun(), findAwaitingApprovalRun(), findAwaitingApprovalRunByJiraIssue(), findAwaitingRunByJiraIssue(), findAwaitingRunBySlackThread(), getRun(), getRunEvents(), listRuns() (+34 more)

### Community 7 - "Community 7"
Cohesion: 0.05
Nodes (51): AccountsPage(), processASGResource(), processDocDBResource(), processEC2Resource(), extractClusterName(), extractServiceName(), getClusterASGs(), isClusterIdle() (+43 more)

### Community 8 - "Community 8"
Cohesion: 0.05
Nodes (44): formatMessageForAudit(), getActiveMCPTools(), getAuditDepth(), getStore(), llmAuditLog(), truncateOutput(), createDeepGraph(), createFastGraph() (+36 more)

### Community 9 - "Community 9"
Cohesion: 0.07
Nodes (26): AccountDetailsDialog(), buildRunReportHtml(), esc(), exportRunToPdf(), formatDuration(), formatTime(), metaCard(), formatTime() (+18 more)

### Community 10 - "Community 10"
Cohesion: 0.1
Nodes (20): getLangfuseCallbackHandler(), resolveModelConfig(), POST(), processStream(), appendMessage(), createThread(), deleteThread(), ensureIndexes() (+12 more)

### Community 11 - "Community 11"
Cohesion: 0.13
Nodes (16): appendMessage(), createThread(), deleteThread(), ensureIndexes(), getCollection(), getThread(), listThreads(), replaceMessages() (+8 more)

### Community 12 - "Community 12"
Cohesion: 0.1
Nodes (7): async(), handleFormSubmit(), handleKeyDown(), copyToClipboard(), exportToMarkdown(), extractMessageContent(), formatMessagesAsMarkdown()

### Community 13 - "Community 13"
Cohesion: 0.19
Nodes (4): getAuditLogRepository(), GET(), AuditService, getRetentionDays()

### Community 14 - "Community 14"
Cohesion: 0.15
Nodes (9): AccountsLayout(), AgentLayout(), AuditLayout(), AuthorizePage(), checkPageAuth(), requireAuth(), can(), SchedulesLayout() (+1 more)

### Community 15 - "Community 15"
Cohesion: 0.17
Nodes (6): fetchAuditData(), handleRefresh(), loadMoreLogs(), handleNextPage(), handlePrevPage(), handleRefresh()

### Community 16 - "Community 16"
Cohesion: 0.22
Nodes (7): consumeStream(), createNewThread(), deleteThread(), fetchThreads(), handleApproval(), handleKeyDown(), handleSend()

### Community 17 - "Community 17"
Cohesion: 0.3
Nodes (2): getScheduleRepository(), ScheduleService

### Community 18 - "Community 18"
Cohesion: 0.23
Nodes (3): getRequiredEnv(), HorizontalExecutor, sleep()

### Community 19 - "Community 19"
Cohesion: 0.29
Nodes (1): Logger

### Community 20 - "Community 20"
Cohesion: 0.24
Nodes (6): describeSchemaNode(), executeSQLNode(), executeReadOnlyQuery(), executeSchemaQuery(), getTextToSQLPool(), validateSQL()

### Community 21 - "Community 21"
Cohesion: 0.2
Nodes (7): generateSQLNode(), reflectNode(), synthesizeNode(), buildReflectionPrompt(), buildSQLGenerationPrompt(), buildSynthesisPrompt(), sanitizeFilterValue()

### Community 22 - "Community 22"
Cohesion: 0.22
Nodes (2): loadAccount(), validateConnection()

### Community 23 - "Community 23"
Cohesion: 0.29
Nodes (5): fetchConfig(), handleAddServer(), handleReset(), handleSave(), updateSummary()

### Community 24 - "Community 24"
Cohesion: 0.38
Nodes (1): FileSaver

### Community 25 - "Community 25"
Cohesion: 0.29
Nodes (5): buildTableEntries(), countPgTable(), padEnd(), padStart(), verify()

### Community 26 - "Community 26"
Cohesion: 0.25
Nodes (2): handleCreate(), resetForm()

### Community 27 - "Community 27"
Cohesion: 0.25
Nodes (4): formatTimestamp(), getStatusBadge(), getStatusIcon(), formatDate()

### Community 28 - "Community 28"
Cohesion: 0.22
Nodes (1): ClientAccountService

### Community 29 - "Community 29"
Cohesion: 0.31
Nodes (6): chunkText(), embedAndStoreChunks(), forceChunk(), getBedrockClient(), getEmbedding(), recursiveSplit()

### Community 30 - "Community 30"
Cohesion: 0.25
Nodes (2): createScheduleViaAPI(), uniqueId()

### Community 32 - "Community 32"
Cohesion: 0.36
Nodes (5): set(), fetchStackOutputs(), main(), mapOutputsToEnvVars(), writeEnvFile()

### Community 33 - "Community 33"
Cohesion: 0.25
Nodes (2): handleSubmit(), onSubmit()

### Community 34 - "Community 34"
Cohesion: 0.25
Nodes (1): ClientScheduleService

### Community 37 - "Community 37"
Cohesion: 0.29
Nodes (1): SafeMongoDBSaver

### Community 38 - "Community 38"
Cohesion: 0.57
Nodes (6): migrate(), migrateEvents(), migrateRuns(), migrateScheduledTasks(), scanAllItems(), ttlToDate()

### Community 39 - "Community 39"
Cohesion: 0.48
Nodes (6): getPool(), handleAgentOpsTick(), loadActiveTasks(), queueName(), register(), writeAuditLog()

### Community 41 - "Community 41"
Cohesion: 0.4
Nodes (2): loadAccounts(), refreshAccounts()

### Community 42 - "Community 42"
Cohesion: 0.53
Nodes (4): generateOnboardingTemplate(), generateOnboardingYaml(), GET(), POST()

### Community 43 - "Community 43"
Cohesion: 0.4
Nodes (3): NotFound(), generateMetadata(), Page()

### Community 45 - "Community 45"
Cohesion: 0.47
Nodes (3): handleSave(), hasAnyPermission(), toPermissionSet()

### Community 46 - "Community 46"
Cohesion: 0.6
Nodes (4): applyFilters(), buildFilters(), computeActiveFilters(), removeFilter()

### Community 47 - "Community 47"
Cohesion: 0.6
Nodes (4): downloadFile(), exportToCSV(), exportToJSON(), handleExport()

### Community 48 - "Community 48"
Cohesion: 0.4
Nodes (2): handleSync(), triggerSync()

### Community 50 - "Community 50"
Cohesion: 0.33
Nodes (1): ClientAuditService

### Community 51 - "Community 51"
Cohesion: 0.53
Nodes (4): formatExtra(), getConfiguredLevel(), log(), ts()

### Community 52 - "Community 52"
Cohesion: 0.53
Nodes (4): migrate(), migrateDataSources(), migrateKnowledgeBases(), queryDataSources()

### Community 53 - "Community 53"
Cohesion: 0.4
Nodes (2): main(), processBatch()

### Community 56 - "Community 56"
Cohesion: 0.6
Nodes (3): fetchKBs(), handleCreate(), handleDelete()

### Community 58 - "Community 58"
Cohesion: 0.4
Nodes (2): handleFileSelect(), fileToBase64()

### Community 59 - "Community 59"
Cohesion: 0.5
Nodes (2): handleImport(), processImport()

### Community 60 - "Community 60"
Cohesion: 0.5
Nodes (2): handleFollowUpClick(), handleSend()

### Community 63 - "Community 63"
Cohesion: 0.4
Nodes (1): ClientAuditService

### Community 65 - "Community 65"
Cohesion: 0.6
Nodes (3): main(), migrateAccounts(), migrateSchedules()

### Community 66 - "Community 66"
Cohesion: 0.6
Nodes (3): migrate(), migrateExecutions(), migrateSchedules()

### Community 79 - "Community 79"
Cohesion: 0.83
Nodes (3): notifyScheduledRunResult(), postToJiraIssue(), postToSlackChannel()

### Community 82 - "Community 82"
Cohesion: 0.83
Nodes (3): main(), migrateInventoryResources(), migrateVectorKeys()

### Community 83 - "Community 83"
Cohesion: 0.83
Nodes (3): ensureTenantExists(), migrate(), scanAllTenantConfigs()

### Community 84 - "Community 84"
Cohesion: 0.83
Nodes (3): isValidRole(), migrate(), scanAllRbacItems()

### Community 85 - "Community 85"
Cohesion: 0.5
Nodes (1): VerticalExecutor

### Community 104 - "Community 104"
Cohesion: 1.0
Nodes (2): gotoAccounts(), gotoEditPage()

### Community 107 - "Community 107"
Cohesion: 1.0
Nodes (2): migrate(), queryAllAuditLogs()

### Community 108 - "Community 108"
Cohesion: 1.0
Nodes (2): migrate(), queryAllAccounts()

## Knowledge Gaps
- **Thin community `Community 17`** (12 nodes): `getScheduleRepository()`, `buildSchedulePK()`, `buildScheduleSK()`, `ScheduleService`, `.createSchedule()`, `.deleteSchedule()`, `.getSchedule()`, `.getSchedules()`, `.getSchedulesWithFilters()`, `.toggleScheduleStatus()`, `.updateSchedule()`, `schedule-service.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 19`** (12 nodes): `Logger`, `.child()`, `.clearContext()`, `.constructor()`, `.debug()`, `.error()`, `.formatMessage()`, `.info()`, `.setContext()`, `.setLevel()`, `.shouldLog()`, `.warn()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 22`** (10 nodes): `getStatusBadge()`, `getStatusIcon()`, `handleNextPage()`, `handlePrevPage()`, `loadAccount()`, `loadActivity()`, `loadResources()`, `loadSchedules()`, `validateConnection()`, `page.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 24`** (10 nodes): `FileSaver`, `.constructor()`, `.getCheckpointPath()`, `.getTuple()`, `.getWritesPath()`, `.hydrate()`, `.list()`, `.put()`, `.putWrites()`, `file-saver.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 26`** (9 nodes): `addModelField()`, `handleCreate()`, `handleDelete()`, `handleTest()`, `handleToggle()`, `removeModelField()`, `resetForm()`, `updateModelField()`, `provider-settings.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 28`** (9 nodes): `ClientAccountService`, `.createAccount()`, `.deleteAccount()`, `.getAccount()`, `.getAccounts()`, `.scanResources()`, `.updateAccount()`, `.validateAccount()`, `client-account-service.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 30`** (9 nodes): `applySearch()`, `clearFilters()`, `createScheduleViaAPI()`, `deleteScheduleViaAPI()`, `getScheduleViaAPI()`, `gotoSchedules()`, `switchToTableView()`, `uniqueId()`, `schedules.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 33`** (8 nodes): `handleOpenChange()`, `handleSubmit()`, `fetchSettings()`, `getOrgInitial()`, `handleLogoUpload()`, `onSubmit()`, `invite-member-dialog.tsx`, `organization-settings-form.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 34`** (8 nodes): `ClientScheduleService`, `.createSchedule()`, `.deleteSchedule()`, `.getSchedule()`, `.getSchedules()`, `.toggleScheduleStatus()`, `.updateSchedule()`, `client-schedule-service.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 37`** (7 nodes): `SafeMongoDBSaver`, `.constructor()`, `.getTuple()`, `.list()`, `.put()`, `.putWrites()`, `safe-mongo-saver.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 41`** (6 nodes): `exportAccounts()`, `handleSelectAccount()`, `handleSelectAll()`, `loadAccounts()`, `refreshAccounts()`, `page-updated.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (6 nodes): `handleClose()`, `handleSync()`, `toggle()`, `toggleAll()`, `triggerSync()`, `sync-accounts-dialog.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (6 nodes): `ClientAuditService`, `.getAuditLogs()`, `.getAuditLogsByCorrelationId()`, `.getAuditLogStats()`, `.logUserAction()`, `client-audit-service-api.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 53`** (6 nodes): `computeContentHash()`, `createResourceText()`, `getEmbedding()`, `main()`, `processBatch()`, `backfill-embeddings.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 58`** (5 nodes): `handleFileSelect()`, `removeFile()`, `fileToBase64()`, `file-upload.tsx`, `file-upload.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 59`** (5 nodes): `handleFileSelect()`, `handleImport()`, `handleJsonValidation()`, `processImport()`, `import-accounts-dialog.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 60`** (5 nodes): `filters()`, `handleClearConversation()`, `handleFollowUpClick()`, `handleSend()`, `ask-ai-dialog.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 63`** (5 nodes): `ClientAuditService`, `.getAuditLogs()`, `.getAuditLogStats()`, `.logUserAction()`, `client-audit-service.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 85`** (4 nodes): `VerticalExecutor`, `.execute()`, `.registerHandler()`, `vertical.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 104`** (3 nodes): `gotoAccounts()`, `gotoEditPage()`, `accounts.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 107`** (3 nodes): `migrate()`, `queryAllAuditLogs()`, `migrate-audit-logs.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 108`** (3 nodes): `migrate()`, `queryAllAccounts()`, `migrate-accounts.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `String()` connect `Community 1` to `Community 0`, `Community 32`, `Community 2`, `Community 3`, `Community 4`, `Community 5`, `Community 7`, `Community 8`, `Community 9`, `Community 39`, `Community 15`, `Community 18`, `Community 19`, `Community 20`, `Community 25`?**
  _High betweenness centrality (0.219) - this node is a cross-community bridge._
- **Why does `getSessionTenantId()` connect `Community 0` to `Community 1`, `Community 2`, `Community 4`, `Community 5`, `Community 6`, `Community 8`, `Community 10`, `Community 13`?**
  _High betweenness centrality (0.110) - this node is a cross-community bridge._
- **Are the 93 inferred relationships involving `getSessionTenantId()` (e.g. with `GET()` and `GET()`) actually correct?**
  _`getSessionTenantId()` has 93 INFERRED edges - model-reasoned connections that need verification._
- **Are the 90 inferred relationships involving `String()` (e.g. with `AuditPage()` and `POST()`) actually correct?**
  _`String()` has 90 INFERRED edges - model-reasoned connections that need verification._
- **Are the 74 inferred relationships involving `getTenantClient()` (e.g. with `GET()` and `PATCH()`) actually correct?**
  _`getTenantClient()` has 74 INFERRED edges - model-reasoned connections that need verification._
- **Are the 48 inferred relationships involving `getPrismaClient()` (e.g. with `POST()` and `GET()`) actually correct?**
  _`getPrismaClient()` has 48 INFERRED edges - model-reasoned connections that need verification._
- **Are the 38 inferred relationships involving `authorize()` (e.g. with `GET()` and `POST()`) actually correct?**
  _`authorize()` has 38 INFERRED edges - model-reasoned connections that need verification._