"use client"

import * as React from "react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { SheetTitle } from "@/components/ui/sheet"
import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import { OrgSwitcher } from "@/components/settings/org-switcher"
import { navMenus } from "@/lib/nav-config"

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { isMobile } = useSidebar()
  return (
    <Sidebar collapsible="icon" {...props}>
      {/*
       * components/ui/sidebar.tsx renders the mobile nav via <Sheet>, which is Radix Dialog
       * under the hood — Dialog.Content requires a Title descendant for screen readers, and
       * this tree had none, so opening the mobile drawer logged "DialogContent requires a
       * DialogTitle" and gave assistive tech no accessible name for it. sr-only keeps it
       * invisible.
       *
       * Gated on isMobile, NOT rendered unconditionally: on desktop this same {children}
       * slot renders inside plain <div>s with no enclosing Dialog.Root (see sidebar.tsx's
       * non-mobile branch), so an unconditional SheetTitle there would call Radix's Dialog
       * context hook outside its provider and throw on every page. isMobile here reads the
       * exact same SidebarContext value sidebar.tsx's own `if (isMobile)` branch does, so
       * this only ever renders when the Sheet — and the Dialog.Root it requires — is
       * actually the thing wrapping it.
       *
       * components/ui/sidebar.tsx itself is a shadcn primitive this repo's convention says
       * not to modify, which is why this lives here instead of at the actual mobile branch.
       */}
      {isMobile && <SheetTitle className="sr-only">Navigation</SheetTitle>}
      <SidebarHeader>
        <OrgSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMenus} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
