"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { themes } from "@/components/settings/theme-registry"

export interface ThemeConfig {
  theme: string
  radius: number
  font: string
}

const defaultConfig: ThemeConfig = {
  theme: "zinc",
  radius: 0.5,
  font: "inter",
}

type ThemeConfigContextType = {
  config: ThemeConfig
  setConfig: (config: ThemeConfig) => void
}

const ThemeConfigContext = React.createContext<ThemeConfigContextType>({
  config: defaultConfig,
  setConfig: () => {},
})

export function ThemeConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfigState] = React.useState<ThemeConfig>(defaultConfig)
  const [mounted, setMounted] = React.useState(false)
  const { resolvedTheme: mode } = useTheme()

  // Initial load from localStorage
  React.useEffect(() => {
    const savedConfig = localStorage.getItem("theme-config")
    if (savedConfig) {
      try {
        const parsed = JSON.parse(savedConfig)
        // Merge with default to ensure all keys exist
        setConfigState({ ...defaultConfig, ...parsed })
      } catch (e) {
        console.error("Failed to parse theme config", e)
      }
    }
    setMounted(true)
  }, [])

  // Persist to localStorage
  const setConfig = React.useCallback((newConfig: ThemeConfig) => {
    setConfigState(newConfig)
    localStorage.setItem("theme-config", JSON.stringify(newConfig))
  }, [])

  // Apply styles
  React.useEffect(() => {
    // We wait for mount to avoid hydration mismatch, but we also want to apply ASAP.
    // If we have a saved config, it's loaded in the first effect.
    // This effect runs whenever config changes.
    // We also depend on 'mode' which comes from next-themes.

    const theme = themes.find((t) => t.name === config.theme)
    if (!theme) return

    const root = document.documentElement
    // Fallback to light if mode is undefined (though next-themes usually handles this)
    const isDark = mode === "dark" 
    const cssVars = isDark ? theme.cssVars.dark : theme.cssVars.light

    Object.entries(cssVars).forEach(([key, value]) => {
      root.style.setProperty(key, value)
    })

    root.style.setProperty("--radius", `${config.radius}rem`)

    let fontVar = "system-ui"
    if (config.font === "inter") fontVar = "var(--font-inter)"
    if (config.font === "manrope") fontVar = "var(--font-manrope)"
    root.style.setProperty("--font-sans", fontVar)

  }, [config, mode])

  if (!mounted) {
      // return null // Uncommment to prevent flash of unstyled content, but might delay FCP
      // for now, render children so at least content is visible
  }

  return (
    <ThemeConfigContext.Provider value={{ config, setConfig }}>
      {children}
    </ThemeConfigContext.Provider>
  )
}

export function useThemeConfig() {
  return React.useContext(ThemeConfigContext)
}
