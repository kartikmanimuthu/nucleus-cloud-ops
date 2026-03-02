// ============================================================================
// Deep Agent Module — Structured Logger
//
// Provides leveled, timestamped logging for all Deep Agent components.
//
// Log levels (set via DEEP_AGENT_LOG_LEVEL env var, default: "info"):
//   debug  - All events including raw stream chunks and store operations
//   info   - Normal operational events (default)
//   warn   - Non-fatal anomalies
//   error  - Errors only
//
// Usage:
//   import { agentLog } from '../logger';
//   agentLog.info('Checkpointer ready', { threadId });
//   agentLog.debug('Raw chunk', { namespace, chunk });
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
    debug: 'DEBUG',
    info: 'INFO ',
    warn: 'WARN ',
    error: 'ERROR',
};

// ANSI colours for terminal readability (no-op in production if not a TTY)
const COLORS: Record<LogLevel, string> = {
    debug: '\x1b[36m',  // cyan
    info: '\x1b[32m',   // green
    warn: '\x1b[33m',   // yellow
    error: '\x1b[31m',  // red
};
const RESET = '\x1b[0m';

function getConfiguredLevel(): number {
    const raw = (process.env.DEEP_AGENT_LOG_LEVEL || 'debug').toLowerCase() as LogLevel;
    return LEVELS[raw] ?? LEVELS.debug;
}

function ts(): string {
    return new Date().toISOString();
}

function formatExtra(extra?: Record<string, unknown>): string {
    if (!extra || Object.keys(extra).length === 0) return '';
    try {
        return ' ' + JSON.stringify(extra, null, 0);
    } catch {
        return ' [unstringifiable]';
    }
}

function log(level: LogLevel, component: string, message: string, extra?: Record<string, unknown>): void {
    if (LEVELS[level] < getConfiguredLevel()) return;

    const color = COLORS[level];
    const label = LEVEL_LABELS[level];
    const extraStr = formatExtra(extra);
    const line = `${color}[DeepAgent][${label}]${RESET} ${ts()} [${component}] ${message}${extraStr}`;

    if (level === 'error') {
        console.error(line);
    } else if (level === 'warn') {
        console.warn(line);
    } else {
        console.log(line);
    }
}

/**
 * Creates a component-scoped logger.
 * e.g. const log = createLogger('MongoClient');
 */
export function createLogger(component: string) {
    return {
        debug: (msg: string, extra?: Record<string, unknown>) => log('debug', component, msg, extra),
        info: (msg: string, extra?: Record<string, unknown>) => log('info', component, msg, extra),
        warn: (msg: string, extra?: Record<string, unknown>) => log('warn', component, msg, extra),
        error: (msg: string, extra?: Record<string, unknown>) => log('error', component, msg, extra),
    };
}

// Default top-level logger (for use without a specific component)
export const agentLog = createLogger('Core');
