import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
    createSessionProfile,
    getOrCreateSessionProfile,
    getTenantCredentialsFilePath,
    __resetProfileCacheForTests,
} from './session-manager';

const TENANT = 'tenant-concurrency-test';

function creds(region = 'us-east-1') {
    return {
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret',
        sessionToken: 'token',
        region,
    };
}

beforeEach(() => {
    __resetProfileCacheForTests();
});

afterEach(async () => {
    await fs.rm(path.dirname(getTenantCredentialsFilePath(TENANT)), { recursive: true, force: true });
});

describe('createSessionProfile concurrency', () => {
    it('keeps every profile when 10 callers write at the same time', async () => {
        const accountIds = Array.from({ length: 10 }, (_, i) => `10000000000${i}`);

        const profiles = await Promise.all(
            accountIds.map(id => createSessionProfile(id, creds(), TENANT)),
        );

        const contents = await fs.readFile(getTenantCredentialsFilePath(TENANT), 'utf-8');
        for (const profile of profiles) {
            expect(contents).toContain(`[${profile.profileName}]`);
        }
    });

    it('writes the credentials file atomically (no partial content observed)', async () => {
        await createSessionProfile('222222222222', creds(), TENANT);
        const filePath = getTenantCredentialsFilePath(TENANT);
        const stat = await fs.stat(filePath);
        expect(stat.mode & 0o777).toBe(0o600);

        const dir = path.dirname(filePath);
        const leftovers = (await fs.readdir(dir)).filter(f => f.endsWith('.tmp'));
        expect(leftovers).toEqual([]);
    });

    it('gives every profile a unique name even within the same millisecond', async () => {
        // 50 back-to-back creations for ONE account will land many in the same ms.
        const profiles = await Promise.all(
            Array.from({ length: 50 }, () => createSessionProfile('999999999999', creds(), TENANT)),
        );

        const names = new Set(profiles.map(p => p.profileName));
        expect(names.size).toBe(50);

        // And every one of them must actually be present in the file.
        const contents = await fs.readFile(getTenantCredentialsFilePath(TENANT), 'utf-8');
        for (const name of names) {
            expect(contents).toContain(`[${name}]`);
        }
    });
});

describe('getOrCreateSessionProfile caching', () => {
    it('reuses a fresh profile instead of assuming again', async () => {
        const assume = vi.fn().mockResolvedValue(creds());

        const first = await getOrCreateSessionProfile('333333333333', TENANT, assume);
        const second = await getOrCreateSessionProfile('333333333333', TENANT, assume);

        expect(assume).toHaveBeenCalledTimes(1);
        expect(second.profileName).toBe(first.profileName);
    });

    it('re-assumes when the cached profile is near expiry', async () => {
        const assume = vi.fn().mockResolvedValue(creds());

        const first = await getOrCreateSessionProfile('444444444444', TENANT, assume);
        // Force the cached entry to be 30s from expiry — inside the 120s refresh margin.
        first.expiresAt = new Date(Date.now() + 30_000);

        const second = await getOrCreateSessionProfile('444444444444', TENANT, assume);

        expect(assume).toHaveBeenCalledTimes(2);
        expect(second.profileName).not.toBe(first.profileName);
    });

    it('scopes the cache by tenant', async () => {
        const assume = vi.fn().mockResolvedValue(creds());

        await getOrCreateSessionProfile('555555555555', TENANT, assume);
        await getOrCreateSessionProfile('555555555555', `${TENANT}-other`, assume);

        expect(assume).toHaveBeenCalledTimes(2);
        await fs.rm(path.dirname(getTenantCredentialsFilePath(`${TENANT}-other`)), { recursive: true, force: true });
    });
});
