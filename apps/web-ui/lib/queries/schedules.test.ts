// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('@/lib/client-schedule-service', () => ({
    ClientScheduleService: {
        getSchedules: vi.fn(),
        getSchedule: vi.fn(),
        createSchedule: vi.fn(),
        updateSchedule: vi.fn(),
        deleteSchedule: vi.fn(),
        toggleScheduleStatus: vi.fn(),
    },
}));

import { ClientScheduleService } from '@/lib/client-schedule-service';
import {
    useSchedules,
    useScheduleExecutions,
    useSchedule,
    useCreateSchedule,
    useUpdateSchedule,
    useDeleteSchedule,
    useToggleSchedule,
} from './schedules';
import { queryKeys } from '@/lib/queries/query-keys';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

describe('schedules queries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('useSchedules', () => {
        it('fetches via ClientScheduleService.getSchedules with filters', async () => {
            vi.mocked(ClientScheduleService.getSchedules).mockResolvedValue({ schedules: [{ id: 's1' }], total: 1 } as any);
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSchedules({ searchTerm: 'x' }), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientScheduleService.getSchedules).toHaveBeenCalledWith({ searchTerm: 'x' });
        });

        it('seeds the cache from options.initialData', () => {
            const seed = { schedules: [{ id: 'seed' }], total: 1 } as any;
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSchedules(undefined, { initialData: seed }), { wrapper });
            expect(result.current.data).toEqual(seed);
        });
    });

    describe('useScheduleExecutions', () => {
        beforeEach(() => {
            vi.stubGlobal('fetch', vi.fn());
        });
        afterEach(() => vi.unstubAllGlobals());

        it('is disabled when scheduleId is undefined', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useScheduleExecutions(undefined, 1, 10), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('encodes the scheduleId and pages via query params', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ executions: [{ executionId: 'e1' }], total: 1 }) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScheduleExecutions('s 1', 2, 10), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/schedules/s%201/history?page=2&limit=10');
            expect(result.current.data).toEqual({ executions: [{ executionId: 'e1' }], total: 1 });
        });

        it('defaults executions/total to empty/0 when the body omits them', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScheduleExecutions('s1', 1, 10), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual({ executions: [], total: 0 });
        });

        it('throws a fixed message on a non-ok response', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScheduleExecutions('s1', 1, 10), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load execution history');
        });
    });

    describe('useSchedule', () => {
        it('does not fetch when id is undefined', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useSchedule(undefined), { wrapper });
            expect(ClientScheduleService.getSchedule).not.toHaveBeenCalled();
        });

        it('fetches the schedule by id', async () => {
            vi.mocked(ClientScheduleService.getSchedule).mockResolvedValue({ id: 's1' } as any);
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSchedule('s1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientScheduleService.getSchedule).toHaveBeenCalledWith('s1');
        });
    });

    describe('mutations', () => {
        it('useCreateSchedule invalidates schedules.all', async () => {
            vi.mocked(ClientScheduleService.createSchedule).mockResolvedValue({ id: 's1' } as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useCreateSchedule(), { wrapper });
            result.current.mutate({ name: 'n' } as any);
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.all });
        });

        it('useUpdateSchedule invalidates lists and the specific detail', async () => {
            vi.mocked(ClientScheduleService.updateSchedule).mockResolvedValue({ id: 's1' } as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useUpdateSchedule(), { wrapper });
            result.current.mutate({ scheduleId: 's1', updates: { status: 'active' } as any });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientScheduleService.updateSchedule).toHaveBeenCalledWith('s1', { status: 'active' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.lists() });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.detail('s1') });
        });

        it('useDeleteSchedule invalidates schedules.all', async () => {
            vi.mocked(ClientScheduleService.deleteSchedule).mockResolvedValue(undefined as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeleteSchedule(), { wrapper });
            result.current.mutate('s1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientScheduleService.deleteSchedule).toHaveBeenCalledWith('s1');
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.all });
        });

        it('useToggleSchedule invalidates lists and the specific detail', async () => {
            vi.mocked(ClientScheduleService.toggleScheduleStatus).mockResolvedValue({ id: 's1' } as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useToggleSchedule(), { wrapper });
            result.current.mutate('s1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientScheduleService.toggleScheduleStatus).toHaveBeenCalledWith('s1');
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.lists() });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.schedules.detail('s1') });
        });
    });
});
