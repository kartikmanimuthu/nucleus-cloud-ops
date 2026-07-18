# Dashboard Wireframes — Refactored Design

**Format:** Figma-style low-fidelity wireframes with annotations  
**Breakpoints:** Desktop (1280px+), Tablet (768–1279px), Mobile (<768px)  
**Design system:** Geist Sans/Mono, Tailwind CSS, Radix UI primitives, semantic color palette only

---

## 1. Color & Typography System

### Semantic color palette (strict)

| Meaning | Tailwind class | Usage |
|---|---|---|
| **Healthy / Success / Saving** | `text-emerald-500` / `bg-emerald-500` | KPI up-trends, running resources, successful executions, connected accounts |
| **Warning / Attention** | `text-amber-500` / `bg-amber-500` | Stale syncs, partial failures, pending approvals |
| **Failure / Critical** | `text-red-500` / `bg-red-500` | Failed executions, disconnected accounts, critical events |
| **Info / Neutral** | `text-slate-500` / `bg-muted` | Labels, borders, disabled states |
| **Primary Brand** | `text-foreground` / `bg-background` | Headers, card surfaces |
| **Chart Series 1** | `hsl(var(--chart-1))` | Primary trend |
| **Chart Series 2** | `hsl(var(--chart-2))` | Secondary comparison |
| **Chart Series 3** | `hsl(var(--chart-3))` | Tertiary comparison |

**Rule:** No hardcoded hex colors in dashboard components.

### Typography scale

| Element | Class | Size | Weight |
|---|---|---|---|
| Page title | `text-3xl font-bold tracking-tight` | 30px | 700 |
| Section title | `text-lg font-semibold` | 18px | 600 |
| Card title | `text-sm font-medium` | 14px | 500 |
| KPI value | `text-2xl font-bold` | 24px | 700 |
| KPI label | `text-xs font-medium text-muted-foreground` | 12px | 500 |
| Body | `text-sm` | 14px | 400 |
| Caption / axis | `text-xs text-muted-foreground` | 12px | 400 |

---

## 2. Desktop Wireframe (1280px+)

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  [S] smc                                                    ⚙️  [U] User                │
├────┬──────────────────────────────────────────────────────────────────────────────────────┤
│    │                                                                                      │
│ Ov │  Dashboard                                        [24h][7d][30d][90d]  🔄         │
│ er │  Platform overview and key metrics                                                   │
│ vi │                                                                                      │
│ ew │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                │
│    │  │ 💰     │ │ 🖥    │ │ 🌐     │ │ 🤖     │ │ ⏸      │ │ ⚠️     │                │
│ Da │  │Est.    │ │Sched.  │ │Accounts│ │ Agent  │ │ Pending│ │Critical│                │
│ sh │  │Savings │ │Success│ │ Synced │ │ Runs   │ │Approvals│ │ Events │               │
│ bo │  │$12.4k  │ │ 94%   │ │ 87/99 │ │  26    │ │   3    │ │   0    │                │
│ ard│  │▲ 18%   │ │▼ 2%   │ │▲ 5    │ │─ 0%    │ │ 🔶     │ │ 🟢     │                │
│    │  │ [spark]│ │ [----]│ │ [----]│ │ [spark]│ │        │ │        │                │
│    │  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘                │
│    │                                                                                      │
│    │  ┌──────────────────────────────────────────────────┐  ┌─────────────────────────┐ │
│    │  │ ⚠️ ACTION CENTER                    [View all →] │  │ ☁️ COVERAGE             │ │
│    │  │                                                  │  │                         │ │
│    │  │ Failed executions                2              │  │ 87  3   2   7          │ │
│    │  │ ┌─────────────────────────────────────────────┐ │  │ 🟢 🟠 🔴 ⚫            │ │
│    │  │ │ 🔴 nightly-stop-prod    3 stopped failed │ │  │ Healthy Stale Disc. Never│ │
│    │  │ │ 🔴 weekend-down-nonprod 1 start  failed  │ │  │                         │ │
│    │  │ └─────────────────────────────────────────────┘ │  │ Last scan: 2h ago       │ │
│    │  │                                                  │  │                         │ │
│    │  │ Agent approvals awaiting input    3             │  │ [Account sync table]    │ │
│    │  │ ┌─────────────────────────────────────────────┐ │  │ Name        Status  Sync │ │
│    │  │ │ ⏸ EC2-rightsize-plan    requested 12m ago │ │  │ STX-APP    🟢       1h   │ │
│    │  │ │ ⏸ Jira-incident-create  requested 1h ago   │ │  │ SMC-PAY    🟠       26h  │ │
│    │  │ └─────────────────────────────────────────────┘ │  │ STX-KYC    🔴       —    │ │
│    │  │                                                  │  │ ... +84 more            │ │
│    │  │ Accounts with sync errors         1             │  │                         │ │
│    │  │ ┌─────────────────────────────────────────────┐ │  └─────────────────────────┘ │
│    │  │ │ 🔴 STX-KYC-PROD   AssumeRole failed  6h ago │ │                            │ │
│    │  │ └─────────────────────────────────────────────┘ │                            │ │
│    │  │                                                  │                            │ │
│    │  │ Critical audit events             0             │                            │ │
│    │  │ ┌─────────────────────────────────────────────┐ │                            │ │
│    │  │ │ 🟢 No critical events in the last 24h      │ │                            │ │
│    │  │ └─────────────────────────────────────────────┘ │                            │ │
│    │  └──────────────────────────────────────────────────┘                            │ │
│    │                                                                                      │
│    │  ┌─────────────────────────────┐  ┌─────────────────────────────┐                  │
│    │  │ 💰 COST & AUTOMATION        │  │ 🤖 AGENT ACTIVITY           │                  │
│    │  │                             │  │                             │                  │
│    │  │ [Area chart: savings trend] │  │ [Donut: scheduled 65%      │                  │
│    │  │                             │  │         manual 25%          │                  │
│    │  │ $12.4k saved · $1.8k/day    │  │         api 10%]            │                  │
│    │  │ Top account: STX-APP        │  │                             │                  │
│    │  │                             │  │ 26 runs · 100% success      │                  │
│    │  │ Recent executions           │  │                             │                  │
│    │  │ Schedule          Action  Status  Time      │  │ Approval queue              │                  │
│    │  │ nightly-stop      Stop    ✅     02:00   │  │ Run                Requested │                  │
│    │  │ weekend-down      Stop    ✅     Sat 20:00│  │ EC2-rightsize      12m ago  │                  │
│    │  │ morning-start     Start   ❌     08:00   │  │ Jira-incident      1h ago   │                  │
│    │  │ ...                          │  │ ...                         │                  │
│    │  │                             │  │                             │                  │
│    │  │ Upcoming actions              │  │ Top tools                   │                  │
│    │  │ Schedule          Next run    Action     │  │ Tool              Success    │                  │
│    │  │ morning-start     Today 20:00  Start     │  │ searchJiraIssues  98%        │                  │
│    │  │ nightly-stop      Tomorrow 02:00 Stop     │  │ editJiraIssue     95%        │                  │
│    │  │ ...                          │  │ slack_post_msg    100%       │                  │
│    │  └─────────────────────────────┘  └─────────────────────────────┘                  │
│    │                                                                                      │
│    │  ┌─────────────────────────────────────────────┐  ┌─────────────────────┐           │
│    │  │ ☁️ INVENTORY SNAPSHOT                      │  │ 🔒 AUDIT SNAPSHOT   │           │
│    │  │                                             │  │                     │           │
│    │  │ [Horizontal bar: resource types]           │  │ [Line: events]      │           │
│    │  │ IAM_ROLES     ████████████████████ 3,100   │  │                     │           │
│    │  │ SSM_PARAMS    ████████████████████ 3,100   │  │ Open findings       │           │
│    │  │ EC2_INSTANCES ████████████████ 2,400         │  │ 🟢 0  🟠 0  🔴 0    │           │
│    │  │ S3_BUCKETS    ████████ 500                   │  │                     │           │
│    │  │ ...                                          │  │ Top event types     │           │
│    │  │                                             │  │ agent.task.cron     │           │
│    │  │ Status breakdown                             │  │ auth.session.login  │           │
│    │  │ Running  603  Stopped  8  Terminated 91     │  │ ...                 │           │
│    │  │ Pending  12   Other      8,288              │  │                     │           │
│    │  │                                             │  │ 225 events · 88% OK │           │
│    │  │ Top accounts by resource count               │  └─────────────────────┘           │
│    │  │ STX-APP  4,200  SMC-PAY  3,100 ...           │                                  │
│    │  │                                             │                                  │
│    │  │ Total 10,000 · 99 accounts · Last scan 2h ago│                                  │
│    │  └─────────────────────────────────────────────┘                                     │
│    │                                                                                      │
└────┴──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Tablet Wireframe (768–1279px)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Dashboard                                    [24h][7d][30d][90d]  🔄   │
│  Platform overview and key metrics                                        │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐    │
│  │ 💰     │ │ 🖥    │ │ 🌐     │ │ 🤖     │ │ ⏸      │ │ ⚠️     │    │
│  │$12.4k  │ │ 94%   │ │ 87/99 │ │  26    │ │   3    │ │   0    │    │
│  │▲ 18%   │ │▼ 2%   │ │▲ 5    │ │─ 0%    │ │ 🔶     │ │ 🟢     │    │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘    │
├─────────────────────────────────────────────────────────────────────────┤
│  ⚠️ ACTION CENTER                              ☁️ COVERAGE              │
│  Failed executions                     2        87 🟢 3 🟠 2 🔴 7 ⚫    │
│  ┌───────────────────────────────┐    ┌───────────────────────────────┐ │
│  │ 🔴 nightly-stop-prod   failed │    │ Last scan: 2h ago             │ │
│  │ 🔴 weekend-down-nonprod fail │    │ STX-APP    🟢 1h              │ │
│  │ ⏸ EC2-rightsize-plan   pending│    │ SMC-PAY    🟠 26h             │ │
│  │ ⏸ Jira-incident-create pending│    │ STX-KYC    🔴 —               │ │
│  │ 🔴 STX-KYC sync error        │    │ ... +84 more                  │ │
│  │ 🟢 No critical events        │    └───────────────────────────────┘ │
│  └───────────────────────────────┘                                      │
├─────────────────────────────────────────────────────────────────────────┤
│  💰 COST & AUTOMATION                          🤖 AGENT ACTIVITY         │
│  [Area chart]                                  [Donut + approval queue]  │
│  Recent executions                  Upcoming  Top tools                 │
│  ...                                           ...                       │
├─────────────────────────────────────────────────────────────────────────┤
│  ☁️ INVENTORY SNAPSHOT                         🔒 AUDIT SNAPSHOT         │
│  [Horizontal bars]                             [Line chart + findings]   │
│  Status breakdown                    Top accounts   Top event types     │
│  Running 603 · Stopped 8 · ...       ...             ...                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Mobile Wireframe (<768px)

```
┌─────────────────────────────┐
│ Dashboard        [Filter ▼] │
│ Platform overview...        │
├─────────────────────────────┤
│ 💰 Est. Savings     $12.4k  │
│    ▲ 18%                    │
├─────────────────────────────┤
│ 🖥 Schedule Success  94%    │
│    ▼ 2%                     │
├─────────────────────────────┤
│ 🌐 Accounts Synced   87/99  │
│    ▲ 5                     │
├─────────────────────────────┤
│ 🤖 Agent Runs          26   │
│    ─ 0%                     │
├─────────────────────────────┤
│ ⏸ Pending Approvals     3    │
│    🔶                       │
├─────────────────────────────┤
│ ⚠️ Critical Events      0    │
│    🟢                       │
├─────────────────────────────┤
│ ⚠️ ACTION CENTER            │
│ Failed executions · 2       │
│ nightly-stop-prod    🔴     │
│ weekend-down-nonprod 🔴     │
│ Agent approvals · 3         │
│ EC2-rightsize-plan   ⏸      │
│ Jira-incident-create ⏸      │
│ Account sync errors · 1     │
│ STX-KYC-PROD         🔴     │
├─────────────────────────────┤
│ ☁️ COVERAGE                 │
│ 🟢87  🟠3  🔴2  ⚫7        │
│ Last scan: 2h ago           │
│ [Account list — collapsed]  │
├─────────────────────────────┤
│ 💰 COST & AUTOMATION        │
│ $12.4k saved · $1.8k/day    │
│ [Trend sparkline]           │
│ Recent executions →         │
│ Upcoming actions →            │
├─────────────────────────────┤
│ 🤖 AGENT ACTIVITY           │
│ 26 runs · 100% success      │
│ Approval queue →            │
│ Top tools →                 │
├─────────────────────────────┤
│ ☁️ INVENTORY SNAPSHOT       │
│ 10,000 resources · 99 accts │
│ [Top 5 types]               │
│ Status breakdown →          │
├─────────────────────────────┤
│ 🔒 AUDIT SNAPSHOT           │
│ 225 events · 88% OK         │
│ Open findings →             │
│ Event timeline →             │
└─────────────────────────────┘
```

---

## 5. Component-level wireframes

### 5.1 KPI card

```
┌─────────────────────────┐
│  Est. Savings        💰 │
│                         │
│       $12.4k            │
│                         │
│  ▲ 18%     vs prev      │
│                         │
│  ~~~~~/~~~~~/\~~~~      │  ← sparkline (only for time-series KPIs)
└─────────────────────────┘
```

**Specs:**
- Padding: `p-4`
- Border: `border border-border rounded-lg`
- Background: `bg-card`
- Hover: subtle shadow + cursor pointer (entire card is a link)
- Delta icon + color based on direction + whether higher-is-better

**KPI definitions:**

| Card | Metric source | Higher-is-better | Link target |
|---|---|---|---|
| 💰 Est. Savings | `cost-automation.summary.totalSavings` | Yes | `/schedules?tab=executions` |
| 🖥 Schedule Success | `ScheduleExecution` success / total | Yes | `/schedules?status=failed` |
| 🌐 Accounts Synced | connected + not stale / total | Yes | `/accounts?filter=stale` |
| 🤖 Agent Runs | `AgentOpsRun` count | Neutral | `/agent-ops?range=24h` |
| ⏸ Pending Approvals | runs in `awaiting_approval` | No | `/agent-ops?status=awaiting_approval` |
| ⚠️ Critical Events | audit logs severity=critical | No | `/audit-logs?severity=critical` |

---

### 5.2 Action Center row item

```
┌────────────────────────────────────────────────────────┐
│  🔴  nightly-stop-prod     3 stopped failed    2h ago   │
│      Account: STX-APPLICATION-PLATFORM-NON-PROD        │
└────────────────────────────────────────────────────────┘
```

**Specs:**
- Left status dot: 8px circle, semantic color
- Title: `text-sm font-medium`
- Meta: `text-xs text-muted-foreground`
- Time: `text-xs text-muted-foreground`, right-aligned
- Hover: `bg-muted/50`
- Click: navigates to filtered view

**Row types:**
- Failed execution → `/schedules?status=failed`
- Pending approval → `/agent-ops/runs/{runId}`
- Account sync error → `/accounts?accountId={id}&tab=logs`
- Critical event → `/audit-logs?severity=critical`

---

### 5.3 Coverage summary

```
┌────────────────────────┐
│  87      3       2      7│
│ 🟢      🟠      🔴      ⚫│
│Healthy  Stale  Disconn. Never│
│                        │
│  Last scan: 2h ago     │
│                        │
│  Name        Status    │
│  STX-APP     🟢  1h    │
│  SMC-PAY     🟠  26h   │
│  STX-KYC     🔴  —     │
│  ... +84 more          │
└────────────────────────┘
```

**Specs:**
- Summary tiles: 4 equal columns, icon + number + label
- Table: 3 columns max (name, status, last sync)
- Stale threshold: 24h
- Status icons: colored dot + label text (accessible, not color-only)

---

### 5.4 Cost & Automation section

```
┌───────────────────────────────────────────┐
│  💰 COST & AUTOMATION                       │
│                                           │
│  $12.4k saved  ·  $1.8k/day avg            │
│  Top account: STX-APP                     │
│                                           │
│  [         Area chart          ]          │
│  Jul 10 Jul 12 Jul 14 Jul 16 Jul 18      │
│                                           │
│  Recent executions              [View →]  │
│  Schedule            Action  Status  Time │
│  nightly-stop        Stop    ✅    02:00  │
│  weekend-down        Stop    ✅    Sat    │
│  morning-start       Start   ❌    08:00  │
│                                           │
│  Upcoming actions               [View →]  │
│  Schedule            Next run    Action     │
│  morning-start       Today 20:00 Start    │
│  nightly-stop        Tomorrow 02:00 Stop  │
└───────────────────────────────────────────┘
```

**Specs:**
- Trend chart height: 240px
- Recent executions: max 5 rows
- Upcoming actions: max 5 rows
- Status icons: ✅ 🟢 / ❌ 🔴 / ⚠️ 🟠
- All rows clickable

---

### 5.5 Agent Activity section

```
┌───────────────────────────────────────────┐
│  🤖 AGENT ACTIVITY                          │
│                                           │
│        ┌──────────┐                       │
│       /   26       \                      │
│      /  scheduled   \     26 runs          │
│      \   65%       /     100% success     │
│       \            /      214.8s avg        │
│        └──────────┘                       │
│       manual 25%  api 10%                 │
│                                           │
│  Approval queue               [View →]    │
│  Run                    Requested         │
│  EC2-rightsize-plan     12m ago           │
│  Jira-incident-create   1h ago            │
│                                           │
│  Top tools                    [View →]    │
│  Tool                 Uses   Success      │
│  searchJiraIssues     64     98%          │
│  editJiraIssue        45     95%          │
│  slack_post_message   12     100%         │
└───────────────────────────────────────────┘
```

**Specs:**
- Donut: only when ≥2 sources; otherwise show a single metric card
- Approval queue: hidden when empty; show empty-state CTA instead
- Top tools: horizontal bar chart or simple table; include success rate

---

### 5.6 Inventory Snapshot section

```
┌─────────────────────────────────────────────────────────┐
│  ☁️ INVENTORY SNAPSHOT                                   │
│                                                         │
│  [Horizontal bar: resource types]                       │
│  IAM_ROLES     ████████████████████████████████  3,100 │
│  SSM_PARAMS    ████████████████████████████████  3,100 │
│  EC2_INSTANCES ██████████████████████████        2,400 │
│  S3_BUCKETS    ██████████████                      500 │
│  ...                                                    │
│                                                         │
│  Status breakdown                                       │
│  Running 603  ·  Stopped 8  ·  Terminated 91         │
│  Pending 12   ·  Other 8,288                         │
│                                                         │
│  Top accounts by resource count            [View all →]│
│  STX-APP              4,200                             │
│  SMC-PAYMENTS-PROD    3,100                             │
│  ...                                                    │
│                                                         │
│  Total 10,000 · 99 accounts synced · Last scan 2h ago  │
└─────────────────────────────────────────────────────────┘
```

**Specs:**
- Horizontal bar chart for types (readable labels)
- Horizontal bar chart for top accounts
- Status breakdown as compact pills, not a donut
- “Other” should be <10%; if larger, surface a drill-down link

---

### 5.7 Audit Snapshot section

```
┌─────────────────────────────┐
│  🔒 AUDIT SNAPSHOT            │
│                             │
│  [Line chart: 24h events]    │
│                             │
│  Open findings              │
│  🟢 0  🟠 0  🔴 0            │
│  Low  Med  High             │
│                             │
│  Top event types            │
│  agent.task.cron_completed  │
│  agent.task.cron_triggered  │
│  auth.session.login         │
│                             │
│  225 events · 88% OK        │
└─────────────────────────────┘
```

**Specs:**
- Line chart: 3 series (success/warning/error)
- Open findings: severity pills with counts
- Top event types: horizontal bar or list, max 5
- Click through to `/audit-logs`

---

## 6. Interaction notes

### Hover states
- KPI cards: `shadow-sm` + `cursor-pointer`
- Table/list rows: `bg-muted/50`
- Chart bars/pie slices: tooltip appears, cursor pointer, click filters module

### Click-through map

| Element | Destination |
|---|---|
| KPI card “Est. Savings” | `/schedules?tab=executions` |
| KPI card “Schedule Success” | `/schedules?status=failed` |
| KPI card “Accounts Synced” | `/accounts?filter=stale` |
| KPI card “Agent Runs” | `/agent-ops?range=24h` |
| KPI card “Pending Approvals” | `/agent-ops?status=awaiting_approval` |
| KPI card “Critical Events” | `/audit-logs?severity=critical` |
| Failed execution row | `/schedules/{scheduleId}/executions` |
| Pending approval row | `/agent-ops/runs/{runId}` |
| Account sync error row | `/accounts/{accountId}?tab=logs` |
| Coverage account row | `/accounts/{accountId}` |
| Inventory type bar | `/inventory?type={resourceType}` |
| Inventory account bar | `/inventory?account={accountId}` |
| Audit event type | `/audit-logs?eventType={type}` |

### Loading states
- Each section skeleton matches the zone layout (not generic spinners).
- KPI row uses 6 small card skeletons.
- Charts use rectangular placeholder with pulse animation.
- Lists use 3–5 row skeletons.

### Empty states
- Each section has its own empty state with a contextual CTA.
- Examples:
  - Cost: “No executions yet. Create a schedule →”
  - Agent: “No agent runs. Open AI Ops →”
  - Inventory: “No resources discovered. Run discovery →”

---

## 7. Responsive behavior

| Breakpoint | Layout change |
|---|---|
| ≥1280px | Full 3-column grid as shown in desktop wireframe |
| 1024–1279px | KPIs 3×2, Action Center + Coverage side-by-side, Cost + Agent side-by-side, Inventory 2/3 + Audit 1/3 |
| 768–1023px | KPIs 2×3, all sections single column |
| <768px | KPIs stacked 1×6, all sections single column, tables become cards |

---

## 8. Next step

Convert this wireframe into a set of React component stubs + TanStack Query hooks + API route stubs, then implement Phase 1 of the refactor plan.
