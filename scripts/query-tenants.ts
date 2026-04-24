#!/usr/bin/env npx tsx
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
    log: ['error'],
});

async function main() {
    const tenants = await prisma.tenant.findMany({
        select: { id: true, name: true, slug: true, createdAt: true },
    });
    console.log(JSON.stringify(tenants, null, 2));
}

main()
    .catch(e => { console.error(e.message); process.exit(1); })
    .finally(() => prisma.$disconnect());
