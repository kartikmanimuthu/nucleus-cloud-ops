// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/client-skill-service', () => ({
    ClientSkillService: {
        listSkills: vi.fn(),
        getSkill: vi.fn(),
        createSkill: vi.fn(),
        updateSkill: vi.fn(),
        deleteSkill: vi.fn(),
        distill: vi.fn(),
    },
}));

import { ClientSkillService } from '@/lib/client-skill-service';
import {
    useSkills,
    useSkill,
    useCreateSkill,
    useUpdateSkill,
    useDeleteSkill,
    useDistillSkill,
} from './skills';
import { queryKeys } from './query-keys';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

describe('skills queries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('useSkills defaults `all` to true and forwards it to the service', async () => {
        vi.mocked(ClientSkillService.listSkills).mockResolvedValue([{ id: 'sk1' }] as any);
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useSkills(), { wrapper });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(ClientSkillService.listSkills).toHaveBeenCalledWith(true);

        vi.mocked(ClientSkillService.listSkills).mockClear();
        renderHook(() => useSkills(false), { wrapper: createWrapper().wrapper });
        await waitFor(() => expect(ClientSkillService.listSkills).toHaveBeenCalledWith(false));
    });

    describe('useSkill', () => {
        it('does not fetch when id is null', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useSkill(null), { wrapper });
            expect(ClientSkillService.getSkill).not.toHaveBeenCalled();
        });

        it('fetches the skill by id', async () => {
            vi.mocked(ClientSkillService.getSkill).mockResolvedValue({ id: 'sk1' } as any);
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSkill('sk1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientSkillService.getSkill).toHaveBeenCalledWith('sk1');
        });
    });

    describe('mutations', () => {
        it('useCreateSkill invalidates skills.all on success', async () => {
            vi.mocked(ClientSkillService.createSkill).mockResolvedValue({ id: 'sk1' } as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useCreateSkill(), { wrapper });
            result.current.mutate({ name: 'n' } as any);
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.skills.all });
        });

        it('useUpdateSkill calls the service with id+input and invalidates skills.all', async () => {
            vi.mocked(ClientSkillService.updateSkill).mockResolvedValue({ id: 'sk1' } as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useUpdateSkill(), { wrapper });
            result.current.mutate({ id: 'sk1', input: { name: 'renamed' } });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientSkillService.updateSkill).toHaveBeenCalledWith('sk1', { name: 'renamed' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.skills.all });
        });

        it('useDeleteSkill invalidates skills.all on success', async () => {
            vi.mocked(ClientSkillService.deleteSkill).mockResolvedValue(undefined as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeleteSkill(), { wrapper });
            result.current.mutate('sk1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientSkillService.deleteSkill).toHaveBeenCalledWith('sk1');
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.skills.all });
        });

        it('useDistillSkill calls the service with threadId+transcript and does not touch the cache', async () => {
            vi.mocked(ClientSkillService.distill).mockResolvedValue({ name: 'n' } as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDistillSkill(), { wrapper });
            result.current.mutate({ threadId: 't1', transcript: 'x' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientSkillService.distill).toHaveBeenCalledWith('t1', 'x');
            expect(invalidateSpy).not.toHaveBeenCalled();
        });
    });
});
