export interface SkillDTO {
    id: string; name: string; description: string; tier: string;
    source: string; isEnabled: boolean; createdBy: string | null; updatedAt: string; content?: string;
}
export interface SkillInput {
    name: string; description: string; tier: string; content: string;
    isEnabled?: boolean; slug?: string; source?: string; sourceRunId?: string | null;
}

async function jsonOrThrow(res: Response) {
    const body = await res.json();
    if (!res.ok || body.success === false) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
}

export const ClientSkillService = {
    async listSkills(all = true): Promise<SkillDTO[]> {
        const res = await fetch(`/api/skills${all ? '?all=1' : ''}`);
        const body = await jsonOrThrow(res);
        return body.skills as SkillDTO[];
    },
    async getSkill(id: string): Promise<SkillDTO> {
        return (await jsonOrThrow(await fetch(`/api/skills/${id}`))).data;
    },
    async createSkill(input: SkillInput): Promise<SkillDTO> {
        return (await jsonOrThrow(await fetch('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }))).data;
    },
    async updateSkill(id: string, input: Partial<SkillInput>): Promise<SkillDTO> {
        return (await jsonOrThrow(await fetch(`/api/skills/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }))).data;
    },
    async deleteSkill(id: string): Promise<void> {
        await jsonOrThrow(await fetch(`/api/skills/${id}`, { method: 'DELETE' }));
    },
    async distill(threadId: string, transcript: string): Promise<{ name: string; description: string; tier: string; content: string }> {
        return (await jsonOrThrow(await fetch('/api/skills/distill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId, transcript }) }))).data;
    },
};
