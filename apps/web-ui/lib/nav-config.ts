import {
  Activity,
  BookOpen,
  Bot,
  Boxes,
  Cable,
  CalendarClock,
  Gauge,
  LayoutDashboard,
  Server,
  Settings,
  ShieldCheck,
  Workflow,
} from "lucide-react"

import type { NavGroup } from "@/components/nav-main"

/**
 * Single source of truth for the sidebar information architecture (grouped +
 * nested). Consumed by AppSidebar (NavMain) and the top-bar Header (page title).
 */
export const navGroups: NavGroup[] = [
  {
    label: "Platform",
    items: [
      { title: "Dashboard", href: "/app/dashboard", icon: LayoutDashboard },
      { title: "Audit Logs", href: "/app/audit", icon: Activity },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "AI Ops", href: "/app/agent", icon: Bot },
      {
        title: "Agent Ops",
        href: "/app/agent-ops",
        icon: Workflow,
        items: [
          { title: "Overview", href: "/app/agent-ops" },
          { title: "Scheduled Tasks", href: "/app/agent-ops/scheduled-tasks" },
          { title: "Jira Settings", href: "/app/agent-ops/jira-settings" },
          { title: "Slack Settings", href: "/app/agent-ops/slack-settings" },
          { title: "MCP Settings", href: "/app/agent-ops/mcp-settings" },
        ],
      },
    ],
  },
  {
    label: "Resources",
    items: [
      { title: "AWS Accounts", href: "/app/accounts", icon: Server },
      { title: "Inventory", href: "/app/inventory", icon: Boxes },
      // Right Sizing — hidden unless the feature flag is enabled (NEXT_PUBLIC_ inlined at build).
      ...(process.env.NEXT_PUBLIC_RIGHT_SIZING_ENABLED === "true"
        ? [{ title: "Right Sizing", href: "/app/right-sizing", icon: Gauge }]
        : []),
      { title: "Cost Scheduler", href: "/app/schedules", icon: CalendarClock },
      { title: "Certificates", href: "/app/certificates", icon: ShieldCheck },
    ],
  },
  {
    label: "Knowledge",
    items: [
      {
        title: "Knowledge Base",
        href: "/app/knowledge-base",
        icon: BookOpen,
        items: [
          { title: "All Bases", href: "/app/knowledge-base" },
          { title: "Ask", href: "/app/knowledge-base/ask" },
        ],
      },
    ],
  },
  {
    label: "Integrations",
    items: [{ title: "Channels", href: "/app/channels", icon: Cable }],
  },
  {
    label: "Settings",
    items: [
      {
        title: "Settings",
        href: "/app/settings",
        icon: Settings,
        items: [
          { title: "Overview", href: "/app/settings" },
          { title: "Members", href: "/app/settings/members" },
          { title: "Roles & Permissions", href: "/app/settings/roles" },
          { title: "Organization", href: "/app/settings/organization" },
          { title: "Providers", href: "/app/settings/providers" },
        ],
      },
    ],
  },
]

/**
 * Returns the page title for the top bar via longest-prefix match against the
 * nav config (parents + nested items). Falls back to the product name.
 */
export function getPageTitle(pathname: string): string {
  let best: { href: string; title: string } | null = null
  const consider = (href: string, title: string) => {
    const matches = pathname === href || pathname.startsWith(`${href}/`)
    if (matches && (best === null || href.length > best.href.length)) {
      best = { href, title }
    }
  }
  for (const group of navGroups) {
    for (const item of group.items) {
      consider(item.href, item.title)
      item.items?.forEach((sub) => consider(sub.href, sub.title))
    }
  }
  return best ? best.title : "Nucleus Cloud Ops"
}
