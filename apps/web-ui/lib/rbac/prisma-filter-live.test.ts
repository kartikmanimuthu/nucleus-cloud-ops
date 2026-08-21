/**
 * THE REGISTRY/SCHEMA COVERAGE INVARIANT, against real data.
 *
 * A row in `rbac_subject_attributes` is a path an administrator may reference in
 * a condition, and `validateCondition()` accepts it precisely BECAUSE it is
 * declared. If the same path has no entry in SUBJECT_FIELDS, the rule passes
 * write-time validation and then throws UntranslatableFilterError the first time
 * a list endpoint evaluates it — a permission that is accepted, saved, and
 * broken.
 *
 * The two tables must be added to together. This suite is what makes forgetting
 * one a test failure rather than a production 500.
 *
 * Reads the database because the property is about data that exists only at
 * runtime; a fixture would test nothing. SKIPS cleanly when unreachable so CI
 * stays green offline.
 *
 * READ-ONLY. This suite must never write to the database.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { unmappedAttributePaths, type DeclaredAttribute } from './prisma-filter';

const prisma = new PrismaClient();

const reachable = await prisma
    .$queryRawUnsafe('select 1')
    .then(() => true)
    .catch(() => false);

const declared: DeclaredAttribute[] = reachable
    ? await prisma.$queryRawUnsafe<DeclaredAttribute[]>(
          `select s.key as "subjectKey", sa.path as path
             from rbac_subject_attributes sa
             join rbac_subjects s on s.id = sa."subjectId"`,
      )
    : [];

afterAll(async () => {
    await prisma.$disconnect();
});

describe.skipIf(!reachable)('registry/schema coverage (live)', () => {
    it('found declared attributes to check', () => {
        // Guards against passing vacuously if the table is empty.
        expect(
            declared.length,
            'no rows in rbac_subject_attributes — nothing was actually checked',
        ).toBeGreaterThan(0);
    });

    it('every declared subject attribute has a Prisma field mapping', () => {
        const violations = unmappedAttributePaths(declared);

        expect(
            violations,
            `these paths are authorable but untranslatable — either map them in ` +
                `SUBJECT_FIELDS or remove the rbac_subject_attributes rows: ${violations.join(', ')}`,
        ).toEqual([]);
    });
});
