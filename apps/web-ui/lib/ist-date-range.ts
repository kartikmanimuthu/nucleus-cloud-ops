import { fromZonedTime } from 'date-fns-tz';

const IST_TZ = 'Asia/Kolkata';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * SEBI is India-based — every date filter across Scale Sentinel (on-screen,
 * CSV/PDF/Excel export, the Direct Connect & VPN report) takes a plain
 * YYYY-MM-DD from an `<input type="date">`, with no time component. Parsing
 * that directly as `new Date(dateStr)` anchors it to UTC midnight, which is
 * 05:30 IST — silently clipping the first ~5.5 hours of `dateFrom` and,
 * used as an inclusive upper bound, nearly the ENTIRE `dateTo` day. Anchor
 * to IST midnight instead, and treat every upper bound as EXCLUSIVE (the
 * start of the day after `dateTo`) so the whole of the last selected day is
 * included — this module is the single place that decision is made.
 */

/** The UTC instant of IST midnight on the given YYYY-MM-DD day. */
export function istDayStart(dateStr: string): Date {
    return fromZonedTime(`${dateStr}T00:00:00.000`, IST_TZ);
}

/** The UTC instant of IST midnight on the day AFTER the given YYYY-MM-DD day
 *  — an exclusive upper bound that still counts every hour of that day. */
export function istDayEndExclusive(dateStr: string): Date {
    return new Date(istDayStart(dateStr).getTime() + DAY_MS);
}

/** A Prisma-ready `{ gte, lt }` date filter for an inclusive IST calendar-day
 *  range, or `undefined` when neither bound was supplied. */
export function istDayRangeFilter(dateFrom?: string, dateTo?: string): { gte?: Date; lt?: Date } | undefined {
    if (!dateFrom && !dateTo) return undefined;
    const filter: { gte?: Date; lt?: Date } = {};
    if (dateFrom) filter.gte = istDayStart(dateFrom);
    if (dateTo) filter.lt = istDayEndExclusive(dateTo);
    return filter;
}
