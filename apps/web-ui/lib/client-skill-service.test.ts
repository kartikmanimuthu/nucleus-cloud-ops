import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientSkillService } from './client-skill-service';

const mockJson = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
});

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('listSkills', () => {
    it('fetches with all=1 by default', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, skills: [{ id: 's1' }] }) as any);

        const result = await ClientSkillService.listSkills();

        expect(fetch).toHaveBeenCalledWith('/api/skills?all=1');
        expect(result).toEqual([{ id: 's1' }]);
    });

    it('omits the all param when all=false', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, skills: [] }) as any);

        await ClientSkillService.listSkills(false);

        expect(fetch).toHaveBeenCalledWith('/api/skills');
    });
});

describe('listSkillsWithContent', () => {
    it('sets withContent=1 and all=1 by default', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, skills: [] }) as any);

        await ClientSkillService.listSkillsWithContent();

        const url = vi.mocked(fetch).mock.calls[0][0] as string;
        expect(url).toContain('all=1');
        expect(url).toContain('withContent=1');
    });

    it('omits the all param when all=false', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, skills: [] }) as any);

        await ClientSkillService.listSkillsWithContent(false);

        const url = vi.mocked(fetch).mock.calls[0][0] as string;
        expect(url).not.toContain('all=1');
        expect(url).toContain('withContent=1');
    });
});

describe('getSkill', () => {
    it('fetches by id and returns data', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, data: { id: 's1', name: 'Skill 1' } }) as any);

        const result = await ClientSkillService.getSkill('s1');

        expect(fetch).toHaveBeenCalledWith('/api/skills/s1');
        expect(result).toEqual({ id: 's1', name: 'Skill 1' });
    });
});

describe('createSkill', () => {
    it('POSTs the input and returns the created skill', async () => {
        const input = { name: 'New', description: 'desc', tier: 'basic', content: 'body' };
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, data: { id: 's2', ...input } }) as any);

        const result = await ClientSkillService.createSkill(input);

        expect(fetch).toHaveBeenCalledWith('/api/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        expect(result.id).toBe('s2');
    });
});

describe('updateSkill', () => {
    it('PATCHes the partial input and returns the updated skill', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, data: { id: 's1', name: 'Renamed' } }) as any);

        const result = await ClientSkillService.updateSkill('s1', { name: 'Renamed' });

        expect(fetch).toHaveBeenCalledWith('/api/skills/s1', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Renamed' }),
        });
        expect(result.name).toBe('Renamed');
    });
});

describe('deleteSkill', () => {
    it('DELETEs the skill by id', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true }) as any);

        await ClientSkillService.deleteSkill('s1');

        expect(fetch).toHaveBeenCalledWith('/api/skills/s1', { method: 'DELETE' });
    });
});

describe('distill', () => {
    it('POSTs threadId + transcript and returns the distilled skill fields', async () => {
        const distilled = { name: 'Distilled', description: 'd', tier: 'basic', content: 'c' };
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, data: distilled }) as any);

        const result = await ClientSkillService.distill('thread-1', 'transcript text');

        expect(fetch).toHaveBeenCalledWith('/api/skills/distill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: 'thread-1', transcript: 'transcript text' }),
        });
        expect(result).toEqual(distilled);
    });
});

describe('jsonOrThrow (shared error handling)', () => {
    it('throws the body error message when res.ok is false', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: false, error: 'Not found' }, 404) as any);

        await expect(ClientSkillService.getSkill('missing')).rejects.toThrow('Not found');
    });

    it('throws a generic status message when the error body has no error field', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({}, 500) as any);

        await expect(ClientSkillService.getSkill('s1')).rejects.toThrow('Request failed (500)');
    });

    it('throws when res.ok is true but body.success is explicitly false', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: false, error: 'Validation failed' }, 200) as any);

        await expect(ClientSkillService.createSkill({ name: 'x', description: 'x', tier: 'basic', content: 'x' }))
            .rejects.toThrow('Validation failed');
    });
});
