// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// jsdom 29 (this repo's version) leaves `window.localStorage` undefined even
// under the jsdom test environment. Zustand's persist middleware resolves its
// default storage via `createJSONStorage(() => window.localStorage)` EAGERLY,
// once, at module-evaluation time (not lazily per call) — and ESM import
// statements are hoisted above any other top-level code, so a plain
// `vi.stubGlobal()` call written before the `import` below still runs AFTER
// the store module has already captured `undefined` as its storage. Must stub
// inside `vi.hoisted()`, which genuinely runs first. Test-only setup, not a
// production polyfill.
vi.hoisted(() => {
    class MemoryStorage {
        private map = new Map<string, string>();
        get length() { return this.map.size; }
        clear() { this.map.clear(); }
        getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
        key(index: number) { return [...this.map.keys()][index] ?? null; }
        removeItem(key: string) { this.map.delete(key); }
        setItem(key: string, value: string) { this.map.set(key, value); }
    }
    (globalThis as any).localStorage = new MemoryStorage();
});

import { useThemeConfigStore, DEFAULT_THEME_CONFIG } from '@/lib/stores/theme-config-store';

describe('useThemeConfigStore', () => {
    beforeEach(() => {
        localStorage.clear();
        useThemeConfigStore.setState({ config: DEFAULT_THEME_CONFIG });
    });

    it('starts with the default theme config', () => {
        expect(useThemeConfigStore.getState().config).toEqual(DEFAULT_THEME_CONFIG);
    });

    it('setConfig replaces the current config', () => {
        useThemeConfigStore.getState().setConfig({ theme: 'blue', radius: 1, font: 'inter' });
        expect(useThemeConfigStore.getState().config).toEqual({ theme: 'blue', radius: 1, font: 'inter' });
    });

    it('persists the config to localStorage under the nucleus-theme-config key', () => {
        useThemeConfigStore.getState().setConfig({ theme: 'blue', radius: 1, font: 'inter' });
        const raw = localStorage.getItem('nucleus-theme-config');
        expect(raw).toBeTruthy();
        expect(JSON.parse(raw!).state.config).toEqual({ theme: 'blue', radius: 1, font: 'inter' });
    });

    it('merges a persisted partial config over the defaults, filling in newly-added keys', () => {
        localStorage.setItem('nucleus-theme-config', JSON.stringify({
            state: { config: { theme: 'rose', radius: 0.5 } }, version: 0,
        }));

        // The merge function only runs on (re)hydration — rehydrate() re-reads storage.
        useThemeConfigStore.persist.rehydrate();

        expect(useThemeConfigStore.getState().config).toEqual({
            theme: 'rose', radius: 0.5, font: DEFAULT_THEME_CONFIG.font,
        });
    });
});
