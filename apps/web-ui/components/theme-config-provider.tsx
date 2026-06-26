"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { themes } from "@/components/settings/theme-registry"
import {
  useThemeConfigStore,
  type ThemeConfig,
} from "@/lib/stores/theme-config-store"

export type { ThemeConfig }

/**
 * Applies the user's theme customization (CSS vars for the selected theme +
 * radius + font) to <html>, reacting to both the zustand theme-config store
 * and the next-themes light/dark mode. State + persistence now live in
 * useThemeConfigStore; this component only owns the DOM side-effects.
 */
export function ThemeConfigProvider({ children }: { children: React.ReactNode }) {
  const config = useThemeConfigStore((s) => s.config)
  const { resolvedTheme: mode } = useTheme()

  React.useEffect(() => {
    const theme = themes.find((t) => t.name === config.theme)
    if (!theme) return

    const root = document.documentElement
    const isDark = mode === "dark"
    const cssVars = isDark ? theme.cssVars.dark : theme.cssVars.light

    Object.entries(cssVars).forEach(([key, value]) => {
      root.style.setProperty(key, value)
    })

    root.style.setProperty("--radius", `${config.radius}rem`)

    // Geist is the default; allow overriding to the mono cut or the system stack.
    let fontVar = "var(--font-geist-sans)"
    if (config.font === "mono") fontVar = "var(--font-geist-mono)"
    if (config.font === "system") fontVar = "ui-sans-serif, system-ui, sans-serif"
    root.style.setProperty("--font-sans", fontVar)
  }, [config, mode])

  return <>{children}</>
}

/**
 * Backwards-compatible hook: same { config, setConfig } shape the Context
 * version exposed, now backed by the zustand store.
 */
export function useThemeConfig() {
  const config = useThemeConfigStore((s) => s.config)
  const setConfig = useThemeConfigStore((s) => s.setConfig)
  return { config, setConfig }
}
