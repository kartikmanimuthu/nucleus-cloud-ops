import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({
    getKnowledgeBaseRepository: vi.fn(),
    getDataSourceRepository: vi.fn(),
}));

import { getKnowledgeBaseRepository, getDataSourceRepository } from '@/lib/db/repository-factory';
import { KnowledgeBaseService } from './service';

const mockKbRepo = {
    listKnowledgeBases: vi.fn(), getKnowledgeBase: vi.fn(), createKnowledgeBase: vi.fn(),
    updateKnowledgeBase: vi.fn(), setKnowledgeBaseStatus: vi.fn(), deleteKnowledgeBase: vi.fn(),
    updateDataSourceCount: vi.fn(), updateVectorCount: vi.fn(),
};
const mockDsRepo = {
    listDataSources: vi.fn(), getDataSource: vi.fn(), getDataSourceContent: vi.fn(),
    createDataSource: vi.fn(), updateDataSource: vi.fn(), deleteDataSource: vi.fn(),
};

describe('KnowledgeBaseService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getKnowledgeBaseRepository).mockReturnValue(mockKbRepo as any);
        vi.mocked(getDataSourceRepository).mockReturnValue(mockDsRepo as any);
    });

    it('listKnowledgeBases delegates to the repository, forwarding the row filter', async () => {
        mockKbRepo.listKnowledgeBases.mockResolvedValueOnce([{ id: 'kb1' }]);
        const rowFilter = { OR: [] } as any;
        const result = await KnowledgeBaseService.listKnowledgeBases('t1', rowFilter);
        expect(mockKbRepo.listKnowledgeBases).toHaveBeenCalledWith('t1', rowFilter);
        expect(result).toEqual([{ id: 'kb1' }]);
    });

    it('getKnowledgeBase delegates to the repository', async () => {
        mockKbRepo.getKnowledgeBase.mockResolvedValueOnce(null);
        expect(await KnowledgeBaseService.getKnowledgeBase('kb1', 't1')).toBeNull();
        expect(mockKbRepo.getKnowledgeBase).toHaveBeenCalledWith('kb1', 't1');
    });

    it('createKnowledgeBase delegates, forwarding createdBy', async () => {
        const input = { name: 'KB' } as any;
        mockKbRepo.createKnowledgeBase.mockResolvedValueOnce({ id: 'kb1', ...input });
        await KnowledgeBaseService.createKnowledgeBase(input, 't1', 'u1');
        expect(mockKbRepo.createKnowledgeBase).toHaveBeenCalledWith(input, 't1', 'u1');
    });

    it('updateKnowledgeBase delegates to the repository', async () => {
        await KnowledgeBaseService.updateKnowledgeBase('kb1', { name: 'New' }, 't1');
        expect(mockKbRepo.updateKnowledgeBase).toHaveBeenCalledWith('kb1', { name: 'New' }, 't1');
    });

    it('setKnowledgeBaseStatus delegates to the repository', async () => {
        await KnowledgeBaseService.setKnowledgeBaseStatus('kb1', 't1', 'ready');
        expect(mockKbRepo.setKnowledgeBaseStatus).toHaveBeenCalledWith('kb1', 't1', 'ready');
    });

    it('deleteKnowledgeBase delegates to the repository', async () => {
        await KnowledgeBaseService.deleteKnowledgeBase('kb1', 't1');
        expect(mockKbRepo.deleteKnowledgeBase).toHaveBeenCalledWith('kb1', 't1');
    });

    it('updateDataSourceCount and updateVectorCount delegate with the signed delta', async () => {
        await KnowledgeBaseService.updateDataSourceCount('kb1', -1, 't1');
        await KnowledgeBaseService.updateVectorCount('kb1', 5, 't1');
        expect(mockKbRepo.updateDataSourceCount).toHaveBeenCalledWith('kb1', -1, 't1');
        expect(mockKbRepo.updateVectorCount).toHaveBeenCalledWith('kb1', 5, 't1');
    });

    it('listDataSources delegates to the data source repository', async () => {
        mockDsRepo.listDataSources.mockResolvedValueOnce([{ id: 'ds1' }]);
        const result = await KnowledgeBaseService.listDataSources('kb1', 't1');
        expect(mockDsRepo.listDataSources).toHaveBeenCalledWith('kb1', 't1');
        expect(result).toEqual([{ id: 'ds1' }]);
    });

    it('getDataSource delegates to the repository', async () => {
        await KnowledgeBaseService.getDataSource('kb1', 'ds1', 't1');
        expect(mockDsRepo.getDataSource).toHaveBeenCalledWith('kb1', 'ds1', 't1');
    });

    it('getDataSourceContent delegates to the repository', async () => {
        mockDsRepo.getDataSourceContent.mockResolvedValueOnce('content');
        expect(await KnowledgeBaseService.getDataSourceContent('kb1', 'ds1', 't1')).toBe('content');
    });

    it('createDataSource delegates to the repository', async () => {
        const input = { name: 'file.txt' } as any;
        await KnowledgeBaseService.createDataSource('kb1', input, 't1');
        expect(mockDsRepo.createDataSource).toHaveBeenCalledWith('kb1', input, 't1');
    });

    it('updateDataSource delegates to the repository', async () => {
        await KnowledgeBaseService.updateDataSource('kb1', 'ds1', { name: 'x' }, 't1');
        expect(mockDsRepo.updateDataSource).toHaveBeenCalledWith('kb1', 'ds1', { name: 'x' }, 't1');
    });

    it('deleteDataSource delegates to the repository', async () => {
        await KnowledgeBaseService.deleteDataSource('kb1', 'ds1', 't1');
        expect(mockDsRepo.deleteDataSource).toHaveBeenCalledWith('kb1', 'ds1', 't1');
    });
});
