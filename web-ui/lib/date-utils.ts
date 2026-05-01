"use client";

import { format, formatInTimeZone } from "date-fns-tz";

// ── Presets ────────────────────────────────────────────────────────────────
// Fixed format strings to avoid hydration mismatches between server/client.
// NEVER use toLocaleString() in components — always go through these presets.

const PRESETS = {
    shortDate: "MMM dd, yyyy", // Jan 15, 2025
    longDate: "MMMM dd, yyyy", // January 15, 2025
    shortDateTime: "MMM dd, yyyy HH:mm", // Jan 15, 2025 14:30
    longDateTime: "MMM dd, yyyy HH:mm:ss", // Jan 15, 2025 14:30:45
    longDateTimeWithZone: "MMM dd, yyyy HH:mm:ss zzz", // Jan 15, 2025 14:30:45 IST
    iso: "yyyy-MM-dd'T'HH:mm:ssXXX", // 2025-01-15T14:30:45+05:30
    timeOnly: "HH:mm", // 14:30
    timeWithSeconds: "HH:mm:ss", // 14:30:45
    timeWithSecondsZone: "HH:mm:ss zzz", // 14:30:45 IST
} as const;

export type DatePreset = keyof typeof PRESETS;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Format a date to a tenant-aware display string.
 *
 * @param input   ISO-8601 string, Date object, or timestamp (assumed UTC).
 * @param preset  Named format preset.
 * @param timeZone  IANA timezone (e.g. "Asia/Kolkata", "America/New_York").
 *                  If omitted, falls back to UTC with an explicit suffix.
 */
export function formatDate(
    input: string | Date | number | null | undefined,
    preset: DatePreset = "shortDate",
    timeZone?: string
): string {
    if (input == null) return "N/A";

    const date =
        typeof input === "string"
            ? new Date(input)
            : typeof input === "number"
              ? new Date(input)
              : input;

    if (isNaN(date.getTime())) return "Invalid Date";

    const fmt = PRESETS[preset];

    if (!timeZone) {
        // SaaS standard: when tenant timezone is unknown, show UTC explicitly
        return formatInTimeZone(date, "UTC", fmt) + " UTC";
    }

    return formatInTimeZone(date, timeZone, fmt);
}

/**
 * Format only the time portion of a date.
 */
export function formatTime(
    input: string | Date | number | null | undefined,
    timeZone?: string
): string {
    return formatDateTime(input, "timeWithSeconds", timeZone);
}

/**
 * Format a date with both date and time.
 */
export function formatDateTime(
    input: string | Date | number | null | undefined,
    preset: DatePreset = "shortDate",
    timeZone?: string
): string {
    return formatDate(input, preset, timeZone);
}

/**
 * Relative time string (e.g. "Just now", "5m ago", "2h ago", "3d ago").
 * Falls back to shortDate format for anything older than a week.
 */
export function getRelativeTime(
    input: string | Date | number,
    timeZone?: string
): string {
    const date =
        typeof input === "string"
            ? new Date(input)
            : typeof input === "number"
              ? new Date(input)
              : input;

    if (isNaN(date.getTime())) return "Invalid Date";

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();

    const minutes = Math.floor(diffMs / (1000 * 60));
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    return formatDateTime(date, "shortDate", timeZone);
}
