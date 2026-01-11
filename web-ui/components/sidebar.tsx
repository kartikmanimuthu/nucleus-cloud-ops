"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { signOut, useSession } from "next-auth/react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  LayoutDashboard,
  Calendar,
  Server,
  Activity,
  Settings,
  LogOut,
  User,
  Bell,
  ChevronLeft,
  ChevronRight,
  Bot,
} from "lucide-react"

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "AWS Accounts", href: "/accounts", icon: Server },
  { name: "Schedules", href: "/schedules", icon: Calendar },
  { name: "Audit Logs", href: "/audit", icon: Activity },
  { name: "AI Agent", href: "/agent", icon: Bot },
  { name: "Settings", href: "/settings", icon: Settings },
]

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const pathname = usePathname()
  const { data: session } = useSession()

  const handleSignOut = () => {
    signOut({ callbackUrl: '/login' })
  }

  const getUserInitials = (name?: string | null) => {
    if (!name) return 'U'
    return name
      .split(' ')
      .map(word => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  return (
    <div
      className={cn(
        "flex flex-col bg-card border-r border-border transition-all duration-300 overflow-hidden",
        collapsed ? "w-16" : "w-64",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        {!collapsed && (
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <Calendar className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-lg text-foreground">Nucleus Ops</span>
          </div>
        )}
        <div className="flex items-center space-x-1">
          {!collapsed && <ThemeToggle />}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(!collapsed)}
            className="h-8 w-8 hover:bg-accent"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-2">
        {navigation.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(`${item.href}/`)
          return (
            <Link key={item.name} href={item.href}>
              <Button
                variant={isActive ? "default" : "ghost"}
                className={cn(
                  "w-full justify-start transition-colors",
                  collapsed && "px-2",
                  !isActive && "hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <item.icon className={cn("h-4 w-4", !collapsed && "mr-2")} />
                {!collapsed && item.name}
              </Button>
            </Link>
          )
        })}
      </nav>

      {/* User Profile */}
      <div className="p-4 border-t border-border">        <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className={cn("w-full justify-start p-2 hover:bg-accent", collapsed && "px-2")}>
            <Avatar className="h-6 w-6">
              <AvatarImage src={session?.user?.image || "/placeholder-user.jpg"} />
              <AvatarFallback className="bg-primary text-primary-foreground">
                {getUserInitials(session?.user?.name)}
              </AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="ml-2 text-left">
                <p className="text-sm font-medium text-foreground">{session?.user?.name || 'User'}</p>
                <p className="text-xs text-muted-foreground">{session?.user?.email || 'user@example.com'}</p>
              </div>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>My Account</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="hover:bg-accent">
            <User className="mr-2 h-4 w-4" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem className="hover:bg-accent">
            <Bell className="mr-2 h-4 w-4" />
            Notifications
          </DropdownMenuItem>
          <DropdownMenuItem className="hover:bg-accent">
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />            <DropdownMenuItem
            className="text-destructive hover:bg-destructive/10"
            onClick={handleSignOut}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    </div>
  )
}
