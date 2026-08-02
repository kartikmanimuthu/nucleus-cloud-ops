import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSkillContent, getSkillSummaries } from '@/lib/skill-service';

/**
 * skill-tool.ts — progressive disclosure of skills as a tool (Claude Code model).
 *
 * The system prompt carries only the skill catalog (name + description lines);
 * the agent calls load_skill(skill_id) at the moment a task phase needs those
 * instructions. Multiple skills can be loaded across one run, each on demand,
 * with no upfront token cost for unused skills.
 *
 * Tenant-scoped and enabled-only: getSkillContent() returns null for disabled
 * or unknown slugs, so a disabled skill (veto) can never be loaded mid-run.
 */
export function createLoadSkillTool(tenantId: string) {
    return tool(
        async ({ skill_id }: { skill_id: string }) => {
            const slug = skill_id.trim();
            const content = await getSkillContent(tenantId, slug);
            if (!content) {
                const catalog = await getSkillSummaries(tenantId).catch(() => 'No specialized skills available.');
                return `Error: skill "${slug}" not found or not enabled for this tenant.\n\n${catalog}`;
            }
            console.log(`🧩 [LOAD_SKILL] Loaded skill "${slug}" into context`);
            return `=== SKILL LOADED: ${slug.toUpperCase()} ===\n${content}\n=== END SKILL ===\n\nFollow these instructions — they define your privileges, safety constraints, and workflow — for all work within this skill's scope.`;
        },
        {
            name: 'load_skill',
            description:
                'Load the full instructions of a specialized skill by its id. The available skills are listed in your system prompt under "Available Skills". Calling this is MANDATORY, not optional: whenever a listed skill\'s description covers the work you are about to do (match on domain — cost, EC2, Jira, security, … — not exact wording), load it BEFORE doing that work. The loaded instructions define privileges, safety rules, and workflow for that scope; doing skill-covered work without loading the skill is an error. You may load multiple skills over one task as different phases require them. Do not call it for skills already loaded in this conversation.',
            schema: z.object({
                skill_id: z.string().describe('The skill id (slug) exactly as listed in the Available Skills catalog'),
            }),
        },
    );
}
