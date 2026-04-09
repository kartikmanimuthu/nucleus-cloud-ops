// Structured JSON logger for workers — supports createLogger(service) pattern
// Used by executor module and any future workers/src/lib consumers

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
    service?: string;
    [key: string]: unknown;
}

class Logger {
    private level: LogLevel;
    private context: LogContext;

    constructor(context: LogContext = {}) {
        this.level = (process.env.LOG_LEVEL as LogLevel) || 'info';
        this.context = context;
    }

    private shouldLog(level: LogLevel): boolean {
        const levels: Record<LogLevel, number> = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3,
        };
        return levels[level] >= levels[this.level];
    }

    private formatMessage(level: LogLevel, message: string, extra?: Record<string, unknown>): string {
        const logEntry = {
            timestamp: new Date().toISOString(),
            level: level.toUpperCase(),
            message,
            ...this.context,
            ...extra,
        };
        return JSON.stringify(logEntry);
    }

    debug(message: string, extra?: Record<string, unknown>): void {
        if (this.shouldLog('debug')) {
            console.log(this.formatMessage('debug', message, extra));
        }
    }

    info(message: string, extra?: Record<string, unknown>): void {
        if (this.shouldLog('info')) {
            console.log(this.formatMessage('info', message, extra));
        }
    }

    warn(message: string, extra?: Record<string, unknown>): void {
        if (this.shouldLog('warn')) {
            console.warn(this.formatMessage('warn', message, extra));
        }
    }

    error(message: string, extra?: Record<string, unknown>): void {
        if (this.shouldLog('error')) {
            console.error(this.formatMessage('error', message, extra));
        }
    }
}

/**
 * Create a named logger instance for a service/module.
 * Usage: const log = createLogger('vertical-executor');
 */
export function createLogger(service: string): Logger {
    return new Logger({ service });
}
