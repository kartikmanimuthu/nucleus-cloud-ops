"use client";

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

interface TenantContextValue {
    timezone: string;
    name: string;
    slug: string | null;
    isLoading: boolean;
    error: string | null;
    refetch: () => Promise<void>;
}

const DEFAULT_TIMEZONE = "UTC";

const TenantContext = createContext<TenantContextValue>({
    timezone: DEFAULT_TIMEZONE,
    name: "",
    slug: null,
    isLoading: true,
    error: null,
    refetch: async () => {},
});

export function TenantProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<Omit<TenantContextValue, "refetch">>({
        timezone: DEFAULT_TIMEZONE,
        name: "",
        slug: null,
        isLoading: true,
        error: null,
    });

    const fetchSettings = useCallback(async () => {
        try {
            const res = await fetch("/api/tenants/settings");
            if (!res.ok) {
                throw new Error(`Failed to fetch tenant settings: ${res.status}`);
            }
            const json = await res.json();
            if (!json.success || !json.data) {
                throw new Error("Invalid tenant settings response");
            }
            setState({
                timezone: json.data.timezone || DEFAULT_TIMEZONE,
                name: json.data.name || "",
                slug: json.data.slug ?? null,
                isLoading: false,
                error: null,
            });
        } catch (err) {
            setState((prev) => ({
                ...prev,
                isLoading: false,
                error: err instanceof Error ? err.message : "Unknown error",
            }));
        }
    }, []);

    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);

    const value: TenantContextValue = {
        ...state,
        refetch: fetchSettings,
    };

    return (
        <TenantContext.Provider value={value}>
            {children}
        </TenantContext.Provider>
    );
}

export function useTenant(): TenantContextValue {
    const ctx = useContext(TenantContext);
    if (!ctx) {
        throw new Error("useTenant must be used within a TenantProvider");
    }
    return ctx;
}
