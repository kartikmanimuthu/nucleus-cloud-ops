import { NextResponse } from 'next/server';
import { loadSkills } from '@/lib/agent/skills/skill-loader';

export async function GET() {
    try {
        const skills = loadSkills();

        return NextResponse.json({
            skills: skills.map(skill => ({
                id: skill.id,
                name: skill.name,
                description: skill.description
            }))
        });
    } catch (error) {
        console.error('[SkillsAPI] Error loading skills:', error);
        return NextResponse.json(
            { error: 'Failed to load skills', details: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        );
    }
}
