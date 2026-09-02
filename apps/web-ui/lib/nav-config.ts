import {
  Bot,
  Cable,
  Gauge,
  LayoutDashboard,
  Server,
  Settings,
  ShieldCheck,
} from "lucide-react"

import type { NavItem } from "@/components/nav-main"

/**
 * Single source of truth for the sidebar information architecture: a two-level
 * menu → submenu tree. Each top-level entry is a collapsible category (icon +
 * label) whose `items` are the navigable links. Consumed by AppSidebar
 * (NavMain) and the top-bar Header (page title).
 */
export const navMenus: NavItem[] = [
  {
    title: "Overview",
    icon: LayoutDashboard,
    items: [
      { title: "Dashboard", href: "/app/dashboard", module: "Dashboard" },
      // Audit lives under Accounts in the permission matrix, matching
      // SUBJECT_TO_MODULE's AuditLog -> Accounts mapping.
      { title: "Audit Logs", href: "/app/audit", module: "Accounts" },
    ],
  },
  {
    title: "Agentic Ops",
    icon: Bot,
    items: [
      { title: "AI Ops", href: "/app/agent", module: "AIOps" },
      { title: "Agent Ops", href: "/app/agent-ops", module: "AIOps" },
      { title: "Memory", href: "/app/memory", module: "AIOps" },
      { title: "Scheduled Tasks", href: "/app/agent-ops/scheduled-tasks", module: "AIOps" },
      { title: "Knowledge Base", href: "/app/knowledge-base", module: "AIOps" },
      { title: "Ask", href: "/app/knowledge-base/ask", module: "AIOps" },
      { title: "Skills", href: "/app/skills", module: "AIOps" },
      { title: "MCP Servers", href: "/app/agent-ops/mcp-settings", module: "AIOps" },
      // LLM providers power the agents, so they live under Agentic Ops in every
      // sense now: the page is at /app/agent-ops/providers and the API declares
      // AIOps. It used to sit under /app/settings/*, which meant three different
      // permissions guarded one feature — the nav said AIOps, the settings layout
      // demanded `read Account`, and the API inferred Settings from its path.
      { title: "Providers", href: "/app/agent-ops/providers", module: "AIOps" },
    ],
  },
  {
    title: "Cloud Operations",
    icon: Server,
    items: [
      { title: "AWS Accounts", href: "/app/accounts", module: "Accounts" },
      { title: "Inventory", href: "/app/inventory", module: "Inventory" },
      // ResourceGraph has no registered subject; without `module` this href would
      // fail OPEN (see the Scale Sentinel note below) and render for every role.
      { title: "Resource Graph", href: "/app/resource-graph", module: "Inventory" },
      // Certificate -> Settings, per SUBJECT_TO_MODULE.
      { title: "Certificates", href: "/app/certificates", module: "Settings" },
      // `module` is the fail-CLOSED fallback, not the primary gate. The
      // ScalingAudit subject claims this href by navPath and wins outright
      // (nav-main.tsx resolves a subject claim before the annotation), so this
      // changes nothing while the registry row is intact.
      //
      // It matters when that row is NOT intact. With no navPath, nothing claims
      // the href, canSeeHref fails OPEN by design (use-can.ts:142-147) and an
      // unannotated entry renders for every role — which is exactly what
      // happened here, see 20260820000000_backfill_subject_navpaths. Annotated,
      // the entry degrades to module-level gating instead of to no gating.
      { title: "Scale Sentinel", href: "/app/cloud-operations/scale-sentinel", module: "Inventory" },
    ],
  },
  {
    title: "Cost Optimization",
    icon: Gauge,
    items: [
      // RightSizing -> Inventory: it only reads inventory and writes advice.
      { title: "Right Sizing", href: "/app/right-sizing", module: "Inventory" },
      // SpotGuard -> Schedules, NOT Inventory. It restarts live ECS tasks, so it
      // belongs with the permission that already means "may change running AWS
      // compute". See the note in lib/rbac/types.ts.
      { title: "Spot Guard", href: "/app/cost-optimization/spot-guard", module: "Schedules" },
      { title: "Cost Scheduler", href: "/app/schedules", module: "Schedules" },
    ],
  },
  {
    title: "Connectors",
    icon: Cable,
    items: [
      { title: "Channels", href: "/app/channels", module: "AIOps" },
      { title: "Slack", href: "/app/channels/slack-settings", module: "AIOps" },
      { title: "Telegram", href: "/app/channels/telegram-settings", module: "AIOps" },
    ],
  },
  {
    title: "IAM",
    icon: ShieldCheck,
    items: [
      { title: "Members", href: "/app/iam/members", module: "IAM" },
      { title: "Roles", href: "/app/iam/roles", module: "IAM" },
    ],
  },
  {
    title: "Settings",
    icon: Settings,
    items: [
      { title: "Overview", href: "/app/settings", module: "Settings" },
      { title: "Organization", href: "/app/settings/organization", module: "Settings" },
    ],
  },
]

/**
 * Returns the page title for the top bar via longest-prefix match against the
 * nav config (categories + their links). Falls back to the product name.
 */
export function getPageTitle(pathname: string): string {
  const candidates: { href: string; title: string }[] = []
  for (const menu of navMenus) {
    if (menu.href) candidates.push({ href: menu.href, title: menu.title })
    menu.items?.forEach((sub) =>
      candidates.push({ href: sub.href, title: sub.title })
    )
  }
  let best: { href: string; title: string } | null = null
  for (const c of candidates) {
    const matches = pathname === c.href || pathname.startsWith(`${c.href}/`)
    if (matches && (best === null || c.href.length > best.href.length)) {
      best = c
    }
  }
  return best ? best.title : "Nucleus Cloud Ops"
}
