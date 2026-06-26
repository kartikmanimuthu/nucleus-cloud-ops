import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ThemeConfig {
    theme: string;
    radius: number;
    font: string;
}

export const DEFAULT_THEME_CONFIG: ThemeConfig = {
    theme: 'zinc',
    radius: 0.5,
    font: 'geist',
};

interface ThemeConfigStore {
    config: ThemeConfig;
    setConfig: (config: ThemeConfig) => void;
}

/**
 * Zustand store for user theme customization (theme name, radius, font),
 * persisted to localStorage. Replaces the previous localStorage-in-Context
 * implementation in theme-config-provider.
 *
 * Note: uses a new storage key ("nucleus-theme-config"); the legacy
 * "theme-config" key is not migrated, so a user who had customized the theme
 * reverts to defaults once (defaults are unchanged, so most users see nothing).
 */
export const useThemeConfigStore = create<ThemeConfigStore>()(
    persist(
        (set) => ({
            config: DEFAULT_THEME_CONFIG,
            setConfig: (config) => set({ config }),
        }),
        {
            name: 'nucleus-theme-config',
            // Always merge persisted config over defaults so newly-added keys exist.
            merge: (persisted, current) => {
                const p = (persisted as Partial<ThemeConfigStore>) ?? {};
                return {
                    ...current,
                    ...p,
                    config: { ...DEFAULT_THEME_CONFIG, ...(p.config ?? {}) },
                };
            },
        },
    ),
);
