import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression guard: LOG_LEVEL is commonly set upper-case ('DEBUG'). The singleton
 * logger must normalize it — an unnormalized 'DEBUG' is not a key in the level map,
 * so shouldLog() compared against `undefined` and silently suppressed EVERY line
 * (including errors). We reload the module per case so the singleton picks up the
 * env value set for that test.
 */
async function loadLoggerWith(logLevel: string | undefined) {
    vi.resetModules();
    if (logLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = logLevel;
    const mod = await import('./logger.js');
    return mod.logger;
}

describe('scheduler logger LOG_LEVEL normalization', () => {
    const OLD = process.env.LOG_LEVEL;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
        logSpy.mockRestore();
        if (OLD === undefined) delete process.env.LOG_LEVEL;
        else process.env.LOG_LEVEL = OLD;
    });

    it('emits info logs when LOG_LEVEL is upper-case DEBUG', async () => {
        const logger = await loadLoggerWith('DEBUG');
        logger.info('hello');
        expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('emits info logs when LOG_LEVEL is upper-case INFO', async () => {
        const logger = await loadLoggerWith('INFO');
        logger.info('hello');
        expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to info for an unrecognized LOG_LEVEL (does not suppress everything)', async () => {
        const logger = await loadLoggerWith('verbose');
        logger.info('hello');
        expect(logSpy).toHaveBeenCalledTimes(1);
    });
});
