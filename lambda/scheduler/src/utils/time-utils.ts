// Time utilities for schedule evaluation
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Check if the current time falls within the schedule's active window
 * 
 * @param startTime - Start time in HH:mm:ss format
 * @param endTime - End time in HH:mm:ss format
 * @param tz - Timezone (e.g., 'Asia/Kolkata', 'America/New_York')
 * @param activeDays - Array of active days (e.g., ['Mon', 'Tue', 'Wed'])
 * @returns true if current time is within the schedule window
 */
export function isCurrentTimeInRange(
    startTime: string,
    endTime: string,
    tz: string,
    activeDays: string[]
): boolean {
    const now = dayjs().tz(tz);
    const currentDay = now.format('ddd'); // 'Mon', 'Tue', etc.

    // Check if today is an active day
    const isActiveDay = activeDays.some(
        (day) => day.toLowerCase() === currentDay.toLowerCase()
    );

    if (!isActiveDay) {
        return false;
    }

    // Parse start and end times for today
    const currentDate = now.format('YYYY-MM-DD');
    const startTimeToday = dayjs.tz(`${currentDate} ${startTime}`, 'YYYY-MM-DD HH:mm:ss', tz);
    let endTimeToday = dayjs.tz(`${currentDate} ${endTime}`, 'YYYY-MM-DD HH:mm:ss', tz);

    // Handle overnight schedules (e.g., 22:00 - 06:00)
    if (endTimeToday.isBefore(startTimeToday)) {
        endTimeToday = endTimeToday.add(1, 'day');
    }

    return now.isAfter(startTimeToday) && now.isBefore(endTimeToday);
}

/**
 * Parse time string to components
 */
export function parseTime(timeStr: string): { hours: number; minutes: number; seconds: number } {
    const parts = timeStr.split(':');
    return {
        hours: parseInt(parts[0] || '0', 10),
        minutes: parseInt(parts[1] || '0', 10),
        seconds: parseInt(parts[2] || '0', 10),
    };
}

/**
 * Get current time in a specific timezone
 */
export function getCurrentTimeInTimezone(tz: string): dayjs.Dayjs {
    return dayjs().tz(tz);
}

/**
 * Format a date for display
 */
export function formatDate(date: Date | string, format = 'YYYY-MM-DD HH:mm:ss'): string {
    return dayjs(date).format(format);
}

/**
 * Calculate TTL timestamp (Unix seconds) for DynamoDB
 * @param daysFromNow - Number of days from now for the item to expire
 */
export function calculateTTL(daysFromNow: number): number {
    return Math.floor(Date.now() / 1000) + daysFromNow * 24 * 60 * 60;
}
