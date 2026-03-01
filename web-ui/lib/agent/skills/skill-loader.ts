import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const SKILLS_DIR = path.join(process.cwd(), 'lib', 'agent', 'skills');

export type SkillTier = 'read-only' | 'mutation' | 'approval-gated';

export interface SkillMetadata {
    id: string;           // Skill folder name (e.g., "debugging")
    name: string;         // Display name from YAML frontmatter
    description: string;  // Short description from YAML frontmatter
    tier: SkillTier;      // Permission tier for UI badge display
    content?: string;     // Full markdown content (loaded on demand)
}

interface SkillFrontmatter {
    name: string;
    description: string;
    tier?: SkillTier;
}

/**
 * Backward-compatibility aliases for deprecated skill IDs.
 * Persisted conversation data referencing old skill IDs will still resolve.
 */
const SKILL_ALIASES: Record<string, string> = {
    'cost-optimization': 'cost-analysis',
    'finops': 'cost-analysis',
    'swe': 'swe-devops',
};

/**
 * Resolve a skill ID through the alias map if applicable.
 */
function resolveSkillId(skillId: string): string {
    return SKILL_ALIASES[skillId] ?? skillId;
}

/**
 * Parse a SKILL.md file and extract frontmatter + content.
 */
function parseSkillFile(filePath: string): { frontmatter: SkillFrontmatter; content: string } | null {
    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');

        // Match YAML frontmatter between --- delimiters
        const frontmatterMatch = fileContent.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

        if (!frontmatterMatch) {
            console.error(`[SkillLoader] No frontmatter found in ${filePath}`);
            return null;
        }

        const frontmatterYaml = frontmatterMatch[1];
        const content = frontmatterMatch[2].trim();

        const frontmatter = yaml.load(frontmatterYaml) as SkillFrontmatter;

        if (!frontmatter.name || !frontmatter.description) {
            console.error(`[SkillLoader] Invalid frontmatter in ${filePath}: missing name or description`);
            return null;
        }

        return { frontmatter, content };
    } catch (error) {
        console.error(`[SkillLoader] Error parsing ${filePath}:`, error);
        return null;
    }
}

/**
 * Load all available skills (metadata only, content on demand).
 */
export function loadSkills(): SkillMetadata[] {
    const skills: SkillMetadata[] = [];

    try {
        if (!fs.existsSync(SKILLS_DIR)) {
            console.warn(`[SkillLoader] Skills directory not found: ${SKILLS_DIR}`);
            return skills;
        }

        const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        for (const skillDir of skillDirs) {
            const skillFilePath = path.join(SKILLS_DIR, skillDir, 'SKILL.md');

            if (!fs.existsSync(skillFilePath)) {
                console.warn(`[SkillLoader] SKILL.md not found in ${skillDir}`);
                continue;
            }

            const parsed = parseSkillFile(skillFilePath);
            if (parsed) {
                skills.push({
                    id: skillDir,
                    name: parsed.frontmatter.name,
                    description: parsed.frontmatter.description,
                    tier: parsed.frontmatter.tier ?? 'read-only',
                });
            }
        }

        console.log(`[SkillLoader] Loaded ${skills.length} skills:`, skills.map(s => `${s.name} (${s.tier})`));
    } catch (error) {
        console.error(`[SkillLoader] Error loading skills:`, error);
    }

    return skills;
}

/**
 * Get skill summaries for system prompt (progressive disclosure).
 * Includes tier badge for clarity.
 */
export function getSkillSummaries(): string {
    const skills = loadSkills();

    if (skills.length === 0) {
        return 'No specialized skills available.';
    }

    const summaries = skills.map(skill =>
        `- **${skill.name}** (${skill.id}) [${skill.tier}]: ${skill.description}`
    ).join('\n');

    return `Available Skills:\n${summaries}`;
}

/**
 * Get a skill by its ID. Resolves aliases automatically.
 */
export function getSkillById(skillId: string): SkillMetadata | null {
    const resolved = resolveSkillId(skillId);
    const skills = loadSkills();
    return skills.find(s => s.id === resolved) || null;
}

/**
 * Load full skill content by ID (for runtime injection).
 * Resolves deprecated skill aliases automatically.
 */
export function getSkillContent(skillId: string): string | null {
    try {
        const resolved = resolveSkillId(skillId);
        if (resolved !== skillId) {
            console.log(`[SkillLoader] Resolved deprecated skill alias: "${skillId}" → "${resolved}"`);
        }

        const skillFilePath = path.join(SKILLS_DIR, resolved, 'SKILL.md');

        if (!fs.existsSync(skillFilePath)) {
            console.error(`[SkillLoader] SKILL.md not found for skill: ${resolved}`);
            return null;
        }

        const parsed = parseSkillFile(skillFilePath);
        if (!parsed) {
            return null;
        }

        return parsed.content;
    } catch (error) {
        console.error(`[SkillLoader] Error loading skill content for ${skillId}:`, error);
        return null;
    }
}
