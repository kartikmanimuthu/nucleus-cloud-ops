/**
 * Fails the build when the registry and SUBJECT_TO_MODULE disagree.
 *
 * ScalingAudit was mapped in code to Inventory for months with no rbac_subjects
 * row. Under the legacy matrix that resolved fine; under CASL the compiler emits
 * one rule per SUBJECT, so the grant simply did not exist and every Scale
 * Sentinel route would have 403'd the moment DYNAMIC_ABAC_ENABLED flipped.
 *
 * That class of bug is invisible until the flag flips, which is exactly when it
 * is most expensive. This is the check that makes it visible at build time.
 */
import { loadGlobalSubjectCoverageRows } from '../lib/rbac/registry';
import { SUBJECT_TO_MODULE } from '../lib/rbac/types';

async function main(): Promise<void> {
    const problems: string[] = [];

    const { subjects, subjectModules: links, modules } = await loadGlobalSubjectCoverageRows();

    const subjectByKey = new Map(subjects.map((s) => [s.key, s]));
    const moduleById = new Map(modules.map((m) => [m.id, m]));
    const moduleIdBySubjectId = new Map(links.map((l) => [l.subjectId, l.moduleId]));

    // 1. Every SUBJECT_TO_MODULE key exists and links to the module it claims.
    for (const [subjectKey, moduleKey] of Object.entries(SUBJECT_TO_MODULE)) {
        if (subjectKey === 'all') continue; // wildcard fallback, not a real subject
        const subject = subjectByKey.get(subjectKey);
        if (!subject) {
            problems.push(`SUBJECT_TO_MODULE['${subjectKey}'] has no rbac_subjects row`);
            continue;
        }
        const linkedModule = moduleById.get(moduleIdBySubjectId.get(subject.id) ?? '');
        if (!linkedModule) {
            problems.push(`subject '${subjectKey}' links to no module`);
        } else if (linkedModule.key !== moduleKey) {
            problems.push(
                `subject '${subjectKey}' links to module '${linkedModule.key}' but SUBJECT_TO_MODULE says '${moduleKey}'`
            );
        }
    }

    // 2. Every subject links to exactly one ENABLED module.
    for (const subject of subjects) {
        const moduleId = moduleIdBySubjectId.get(subject.id);
        if (!moduleId) {
            problems.push(`subject '${subject.key}' links to no module`);
            continue;
        }
        const module = moduleById.get(moduleId);
        if (module && !module.enabled) {
            problems.push(`subject '${subject.key}' links to disabled module '${module.key}'`);
        }
    }

    // 3. No two subjects share a navPath — resolveNavOwner would be ambiguous.
    const byNavPath = new Map<string, string[]>();
    for (const subject of subjects) {
        if (!subject.navPath) continue;
        byNavPath.set(subject.navPath, [...(byNavPath.get(subject.navPath) ?? []), subject.key]);
    }
    for (const [navPath, keys] of byNavPath) {
        if (keys.length > 1) problems.push(`navPath '${navPath}' claimed by ${keys.join(', ')}`);
    }

    if (problems.length > 0) {
        console.error('[rbac] subject coverage FAILED:');
        for (const problem of problems) console.error(`  - ${problem}`);
        process.exit(1);
    }
    console.log(`[rbac] subject coverage OK — ${subjects.length} subjects, ${byNavPath.size} navPaths`);
}

main()
    .catch((error) => {
        console.error('[rbac] subject coverage check errored:', error);
        process.exit(1);
    })
    .finally(() => process.exit(0));
