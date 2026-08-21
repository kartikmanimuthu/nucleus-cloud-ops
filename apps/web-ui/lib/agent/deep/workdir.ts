import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadSkills, loadAllSkillContent } from '@/lib/skill-service';

const AGENT_WORKDIR = path.resolve(process.env.AGENT_WORKDIR || path.join(os.tmpdir(), 'nucleus-agent'));

const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

export function tenantWorkdir(tenantId: string): string {
    const safe = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(AGENT_WORKDIR, safe);
}

// Routed by CompositeBackend to StoreBackend (Postgres agent_files), never to container
// disk: ECS storage is ephemeral, so a disk-backed AGENTS.md is wiped on every deploy.
export const MEMORIES_ROUTE = '/memories/';
export const AGENTS_MD_PATH = '/memories/AGENTS.md';

export async function ensureWorkdir(root: string): Promise<void> {
    await fs.mkdir(root, { recursive: true });
}

// Descriptions are prose: they contain ':', '>', '#', quotes and markdown. Written raw they
// produce invalid YAML frontmatter and the skills middleware silently skips the skill
// ("Invalid YAML in /skills/<x>/SKILL.md", "missing required 'name' or 'description'").
// Double-quoted YAML needs only \ and " escaped; newlines are collapsed before this.
function yamlQuote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function materializeSkills(tenantId: string, root: string): Promise<number> {
    const metadata = await loadSkills(tenantId);
    if (metadata.length === 0) return 0;
    const contentBySlug = await loadAllSkillContent(tenantId);

    let written = 0;
    for (const skill of metadata) {
        const content = contentBySlug.get(skill.id);
        if (!content) continue;
        const name = skill.id.replace(/[^a-z0-9-]/g, '-').slice(0, 64);
        const description = skill.description.replace(/\s*\n\s*/g, ' ').slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
        const dir = path.join(root, 'skills', name);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
            path.join(dir, 'SKILL.md'),
            `---\nname: ${name}\ndescription: ${yamlQuote(description)}\n---\n\n${content}\n`,
            'utf-8',
        );
        written++;
    }
    return written;
}
