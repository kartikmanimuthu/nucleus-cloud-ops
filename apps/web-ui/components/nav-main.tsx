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
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
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
  href: string
  icon: LucideIcon
  items?: NavSubItem[]
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

/**
 * Returns the single best-matching href for the current pathname — the longest
 * href that the pathname equals or starts with. Longest-prefix wins so an
 * "overview" link (e.g. /app/settings) doesn't stay active on a deeper child
 * route (e.g. /app/settings/members).
 */
function useBestMatch(groups: NavGroup[]): string | null {
  const pathname = usePathname()
  return React.useMemo(() => {
    const hrefs: string[] = []
    for (const group of groups) {
      for (const item of group.items) {
        hrefs.push(item.href)
        item.items?.forEach((sub) => hrefs.push(sub.href))
      }
    }
    let best: string | null = null
    for (const href of hrefs) {
      const matches = pathname === href || pathname.startsWith(`${href}/`)
      if (matches && (best === null || href.length > best.length)) {
        best = href
      }
    }
    return best
  }, [groups, pathname])
}

export function NavMain({ groups }: { groups: NavGroup[] }) {
  const bestMatch = useBestMatch(groups)

  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarMenu>
            {group.items.map((item) => {
              const childActive = item.items?.some((s) => s.href === bestMatch)
              const itemActive = item.href === bestMatch
              const Icon = item.icon

              if (!item.items?.length) {
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={itemActive}
                      tooltip={item.title}
                    >
                      <Link href={item.href}>
                        <Icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              }

              return (
                <Collapsible
                  key={item.title}
                  asChild
                  defaultOpen={itemActive || childActive}
                  className="group/collapsible"
                >
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={itemActive}
                      tooltip={item.title}
                    >
                      <Link href={item.href}>
                        <Icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuAction className="transition-transform data-[state=open]:rotate-90">
                        <ChevronRight />
                        <span className="sr-only">Toggle {item.title}</span>
                      </SidebarMenuAction>
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
      ))}
    </>
  )
}
