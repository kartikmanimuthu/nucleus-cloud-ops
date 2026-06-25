type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) || 'debug';
const serviceName: string = process.env.SERVICE_NAME || 'workers';

export interface Logger {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(module: string): Logger {
    function shouldLog(level: LogLevel): boolean {
        return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
    }

    function formatLog(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
        const ts = new Date().toISOString();
        const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
        return `${ts} [${level.toUpperCase()}] [${serviceName}:${module}] ${message}${metaStr}`;
    }

    return {
        debug: (msg, meta) => { if (shouldLog('debug')) console.debug(formatLog('debug', msg, meta)); },
        info: (msg, meta) => { if (shouldLog('info')) console.log(formatLog('info', msg, meta)); },
        warn: (msg, meta) => { if (shouldLog('warn')) console.warn(formatLog('warn', msg, meta)); },
        error: (msg, meta) => { if (shouldLog('error')) console.error(formatLog('error', msg, meta)); },
    };
}
