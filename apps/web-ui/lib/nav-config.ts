import {
  Bot,
  Cable,
  Gauge,
  LayoutDashboard,
  Server,
  Settings,
} from "lucide-react"

import type { NavItem } from "@/components/nav-main"
import { env } from "@/env"

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
      { title: "Dashboard", href: "/app/dashboard" },
      { title: "Audit Logs", href: "/app/audit" },
    ],
  },
  {
    title: "Agentic Ops",
    icon: Bot,
    items: [
      { title: "AI Ops", href: "/app/agent" },
      { title: "Agent Ops", href: "/app/agent-ops" },
      { title: "Memory", href: "/app/memory" },
      { title: "Scheduled Tasks", href: "/app/agent-ops/scheduled-tasks" },
      { title: "Knowledge Base", href: "/app/knowledge-base" },
      { title: "Ask", href: "/app/knowledge-base/ask" },
      { title: "Skills", href: "/app/skills" },
      // LLM providers power the agents — grouped with Agentic Ops, not Settings.
      { title: "Providers", href: "/app/settings/providers" },
    ],
  },
  {
    title: "Cloud Operations",
    icon: Server,
    items: [
      { title: "AWS Accounts", href: "/app/accounts" },
      { title: "Inventory", href: "/app/inventory" },
      { title: "Certificates", href: "/app/certificates" },
    ],
  },
  {
    title: "Cost Optimization",
    icon: Gauge,
    items: [
      // Right Sizing — hidden unless the feature flag is enabled (NEXT_PUBLIC_ inlined at build).
      ...(env.NEXT_PUBLIC_RIGHT_SIZING_ENABLED === "true"
        ? [{ title: "Right Sizing", href: "/app/right-sizing" }]
        : []),
      { title: "Cost Scheduler", href: "/app/schedules" },
    ],
  },
  {
    title: "Connectors",
    icon: Cable,
    items: [
      { title: "Channels", href: "/app/channels" },
      { title: "Jira", href: "/app/agent-ops/jira-settings" },
      { title: "Slack", href: "/app/agent-ops/slack-settings" },
      { title: "MCP Servers", href: "/app/agent-ops/mcp-settings" },
    ],
  },
  {
    title: "Settings",
    icon: Settings,
    items: [
      { title: "Overview", href: "/app/settings" },
      { title: "Members", href: "/app/settings/members" },
      { title: "Roles & Permissions", href: "/app/settings/roles" },
      { title: "Organization", href: "/app/settings/organization" },
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
