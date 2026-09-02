import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockEnv } = vi.hoisted(() => ({ mockEnv: {} as { DEEP_AGENT_LOG_LEVEL?: string } }));
vi.mock('@/env', () => ({ env: mockEnv }));

import { createLogger, agentLog } from './logger';

describe('deep-agent logger', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockEnv.DEEP_AGENT_LOG_LEVEL = undefined;
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('defaults to the debug level when DEEP_AGENT_LOG_LEVEL is unset, logging debug messages', () => {
        const log = createLogger('Test');
        log.debug('a debug message');
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toContain('[DeepAgent][DEBUG]');
        expect(logSpy.mock.calls[0][0]).toContain('[Test]');
        expect(logSpy.mock.calls[0][0]).toContain('a debug message');
    });

    it('routes info to console.log, warn to console.warn, and error to console.error', () => {
        const log = createLogger('Test');
        log.info('info msg');
        log.warn('warn msg');
        log.error('error msg');
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('[WARN ]');
        expect(errorSpy.mock.calls[0][0]).toContain('[ERROR]');
    });

    it('suppresses levels below the configured threshold', () => {
        mockEnv.DEEP_AGENT_LOG_LEVEL = 'warn';
        const log = createLogger('Test');
        log.debug('suppressed');
        log.info('suppressed');
        log.warn('shown');
        log.error('shown');
        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('is case-insensitive on the configured level', () => {
        mockEnv.DEEP_AGENT_LOG_LEVEL = 'ERROR';
        const log = createLogger('Test');
        log.warn('suppressed');
        log.error('shown');
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to debug for an unrecognized configured level', () => {
        mockEnv.DEEP_AGENT_LOG_LEVEL = 'trace';
        const log = createLogger('Test');
        log.debug('shown because unrecognized level falls back to debug');
        expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('appends extra context as JSON when provided', () => {
        const log = createLogger('Test');
        log.info('with extra', { threadId: 't1', count: 3 });
        expect(logSpy.mock.calls[0][0]).toContain('{"threadId":"t1","count":3}');
    });

    it('omits the extra suffix entirely when extra is absent or empty', () => {
        const log = createLogger('Test');
        log.info('no extra');
        log.info('empty extra', {});
        expect(logSpy.mock.calls[0][0].endsWith('no extra')).toBe(true);
        expect(logSpy.mock.calls[1][0].endsWith('empty extra')).toBe(true);
    });

    it('falls back to [unstringifiable] when extra contains a circular reference', () => {
        const circular: any = {};
        circular.self = circular;
        const log = createLogger('Test');
        log.info('circular', circular);
        expect(logSpy.mock.calls[0][0]).toContain('[unstringifiable]');
    });

    it('exposes a default top-level logger scoped to "Core"', () => {
        agentLog.info('core message');
        expect(logSpy.mock.calls[0][0]).toContain('[Core]');
    });
});
