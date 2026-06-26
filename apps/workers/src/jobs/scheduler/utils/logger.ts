// Structured JSON logger optimized for Lambda/CloudWatch

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
    executionId?: string;
    scheduleId?: string;
    accountId?: string;
    region?: string;
    resourceId?: string;
    [key: string]: unknown;
}

class Logger {
    private level: LogLevel;
    private context: LogContext;

    constructor(level: LogLevel = 'info') {
        this.level = level;
        this.context = {};
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

    private formatMessage(level: LogLevel, message: string, extra?: LogContext): string {
        const logEntry = {
            timestamp: new Date().toISOString(),
            level: level.toUpperCase(),
            message,
            ...this.context,
            ...extra,
        };
        return JSON.stringify(logEntry);
    }

    setContext(context: LogContext): void {
        this.context = { ...this.context, ...context };
    }

    clearContext(): void {
        this.context = {};
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    debug(message: string, extra?: LogContext): void {
        if (this.shouldLog('debug')) {
            console.log(this.formatMessage('debug', message, extra));
        }
    }

    info(message: string, extra?: LogContext): void {
        if (this.shouldLog('info')) {
            console.log(this.formatMessage('info', message, extra));
        }
    }

    warn(message: string, extra?: LogContext): void {
        if (this.shouldLog('warn')) {
            console.warn(this.formatMessage('warn', message, extra));
        }
    }

    error(message: string, error?: Error | unknown, extra?: LogContext): void {
        if (this.shouldLog('error')) {
            const errorDetails: LogContext = { ...extra };
            if (error instanceof Error) {
                errorDetails.errorMessage = error.message;
                errorDetails.stack = error.stack;
            } else if (error) {
                errorDetails.errorMessage = String(error);
            }
            console.error(this.formatMessage('error', message, errorDetails));
        }
    }

    // Create a child logger with additional context
    child(context: LogContext): Logger {
        const childLogger = new Logger(this.level);
        childLogger.context = { ...this.context, ...context };
        return childLogger;
    }
}

// Singleton logger instance
const logLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
export const logger = new Logger(logLevel);

export default logger;
