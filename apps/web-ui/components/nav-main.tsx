"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronRight, type LucideIcon } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { resolveNavOwner } from "@nucleus/rbac"
import { useAbilityMeta, useNavGate } from "@/hooks/use-can"

export interface NavSubItem {
  title: string
  href: string
  /**
   * Module that owns this destination, e.g. "AIOps".
   *
   * Declared rather than inferred from the href. useNavGate() maps a path to a
   * module by prefix against rbac_modules.navPath, and most routes do not match:
   * `/app/agent-ops` is not a child of AIOps's navPath `/app/agent` (the prefix
   * test needs `/app/agent/`), and `/app/memory`, `/app/knowledge-base`,
   * `/app/skills` and `/app/audit` match nothing at all. Unmatched paths fall
   * through to "visible", so most of the sidebar was ungated.
   */
  module?: string
}

export interface NavItem {
  title: string
  icon: LucideIcon
  /** Optional direct route. Category items (with `items`) usually omit this. */
  href?: string
  /** Module owning a direct-route category. See NavSubItem.module. */
  module?: string
  items?: NavSubItem[]
}

/**
 * Returns the single best-matching href for the current pathname — the longest
 * href that the pathname equals or starts with. Longest-prefix wins so an
 * "overview" link (e.g. /app/settings) doesn't stay active on a deeper child
 * route (e.g. /app/settings/members).
 */
function useBestMatch(items: NavItem[]): string | null {
  const pathname = usePathname()
  return React.useMemo(() => {
    const hrefs: string[] = []
    for (const item of items) {
      if (item.href) hrefs.push(item.href)
      item.items?.forEach((sub) => hrefs.push(sub.href))
    }
    let best: string | null = null
    for (const href of hrefs) {
      const matches = pathname === href || pathname.startsWith(`${href}/`)
      if (matches && (best === null || href.length > best.length)) {
        best = href
      }
    }
    return best
  }, [items, pathname])
}

/**
 * Drops destinations the user cannot read, then drops any category left empty.
 *
 * A category whose children are all hidden must go too — an expandable that
 * opens onto nothing is worse than no entry at all.
 */
function useVisibleItems(items: NavItem[]): NavItem[] {
  const { isLoaded, canSeeHref, canSeeModule } = useNavGate()
  const { subjects } = useAbilityMeta()

  const subjectOwns = React.useCallback(
    (href: string) => resolveNavOwner(href, subjects, [])?.kind === "subject",
    [subjects]
  )

  // Resolution order: a subject that claims this href wins, THEN the declared
  // module annotation, THEN module-navPath inference, THEN visible.
  //
  // The declared `module` used to short-circuit first, which would shadow every
  // subject navPath — all nine Agentic Ops entries declare module "AIOps", so
  // Providers could never be gated on its own subject. The annotations survive
  // as the fallback for destinations no subject claims (nothing regresses); they
  // just stop outranking a more specific claim.
  const canSee = (entry: { href?: string; module?: string }): boolean => {
    if (entry.href && subjectOwns(entry.href)) return canSeeHref(entry.href)
    if (entry.module) return canSeeModule(entry.module)
    return !entry.href || canSeeHref(entry.href)
  }

  return React.useMemo(() => {
    // Rules not in yet — render nothing rather than flash entries the user is
    // about to lose. See useNavGate().
    if (!isLoaded) return []

    const visible: NavItem[] = []
    for (const item of items) {
      if (!item.items?.length) {
        if (canSee(item)) visible.push(item)
        continue
      }
      const subs = item.items.filter((sub) => canSee(sub))
      if (subs.length > 0) visible.push({ ...item, items: subs })
    }
    return visible
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, isLoaded, canSeeHref, canSeeModule, subjectOwns])
}

export function NavMain({ items }: { items: NavItem[] }) {
  const visibleItems = useVisibleItems(items)
  const bestMatch = useBestMatch(visibleItems)

  return (
    <SidebarGroup>
      <SidebarMenu>
        {visibleItems.map((item) => {
          const Icon = item.icon
          const childActive = item.items?.some((s) => s.href === bestMatch)
          const itemActive = item.href === bestMatch

          // Leaf item (no submenu) — render as a direct link.
          if (!item.items?.length) {
            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  isActive={itemActive}
                  tooltip={item.title}
                >
                  <Link href={item.href ?? "#"}>
                    <Icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          }

          // Category — the button toggles its submenu (it has no page of its own).
          return (
            <Collapsible
              key={item.title}
              asChild
              defaultOpen={itemActive || childActive}
              className="group/collapsible"
            >
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton
                    tooltip={item.title}
                    isActive={childActive}
                  >
                    <Icon />
                    <span>{item.title}</span>
                    <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {item.items.map((sub) => (
                      <SidebarMenuSubItem key={sub.title}>
                        <SidebarMenuSubButton
                          asChild
                          isActive={sub.href === bestMatch}
                        >
                          <Link href={sub.href}>
                            <span>{sub.title}</span>
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
