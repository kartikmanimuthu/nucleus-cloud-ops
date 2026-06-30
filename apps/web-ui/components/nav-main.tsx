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

export interface NavSubItem {
  title: string
  href: string
}

export interface NavItem {
  title: string
  icon: LucideIcon
  /** Optional direct route. Category items (with `items`) usually omit this. */
  href?: string
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

export function NavMain({ items }: { items: NavItem[] }) {
  const bestMatch = useBestMatch(items)

  return (
    <SidebarGroup>
      <SidebarMenu>
        {items.map((item) => {
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
