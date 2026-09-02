import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// fs/promises is fully mocked in this file — real disk (including the developer's
// real ~/.aws/credentials, which the legacy no-tenantId path writes to) must never
// be touched. session-manager.test.ts covers the real-filesystem, tenant-scoped path.
const fsMock = vi.hoisted(() => ({
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('fs/promises', () => fsMock);

import {
    createSessionProfile, cleanupTenantCredentials, cleanupAllAgentProfiles,
    getTenantCredentialsFilePath, getTenantConfigFilePath, __resetProfileCacheForTests,
} from './session-manager';

function creds() {
    return { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST', region: 'us-east-1' };
}

// The module runs cleanupAllAgentProfiles() fire-and-forget at import time (server
// startup behavior). Let that settle before any test's mocks are in play, so it
// can't race with a test's own mockResolvedValueOnce() calls.
beforeAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('getTenantCredentialsFilePath / getTenantConfigFilePath', () => {
    it('sanitizes unsafe characters out of the tenantId', () => {
        const credsPath = getTenantCredentialsFilePath('tenant/../../etc');
        expect(credsPath).not.toContain('..');
        expect(credsPath.endsWith('credentials')).toBe(true);
    });

    it('replaces every unsafe character rather than stripping to empty', () => {
        expect(getTenantCredentialsFilePath('***')).toContain('___');
    });

    it('falls back to "default" when the tenantId is an empty string', () => {
        expect(getTenantCredentialsFilePath('')).toContain('default');
    });

    it('config path uses the same sanitized tenant dir with a "config" filename', () => {
        const configPath = getTenantConfigFilePath('tenant-1');
        expect(configPath.endsWith('config')).toBe(true);
        expect(configPath).toContain('tenant-1');
    });
});

describe('createSessionProfile — legacy (no tenantId) path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __resetProfileCacheForTests();
        fsMock.readFile.mockResolvedValue('');
    });

    it('writes to the legacy shared credentials file when no tenantId is given', async () => {
        const profile = await createSessionProfile('123456789012', creds());
        expect(profile.credentialsFile).toContain('.aws');
        expect(profile.credentialsFile).toContain('credentials');
        expect(profile.credentialsFile).not.toContain('nucleus-aws-creds');
        expect(fsMock.writeFile).toHaveBeenCalled();
    });

    it('treats a missing credentials file (ENOENT) as empty content rather than throwing', async () => {
        const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
        fsMock.readFile.mockRejectedValueOnce(enoent);
        await expect(createSessionProfile('123456789012', creds())).resolves.toBeDefined();
    });

    it('rethrows a non-ENOENT read error', async () => {
        fsMock.readFile.mockRejectedValueOnce(new Error('permission denied'));
        await expect(createSessionProfile('123456789012', creds())).rejects.toThrow('permission denied');
    });

    it('cleans up the temp file and rethrows when the write fails', async () => {
        fsMock.writeFile.mockRejectedValueOnce(new Error('disk full'));
        await expect(createSessionProfile('123456789012', creds())).rejects.toThrow('disk full');
        expect(fsMock.rm).toHaveBeenCalledWith(expect.stringContaining('.tmp'), { force: true });
    });

    it('preserves an existing profile section already present in the file (parseCredentialsFile skips stray kv lines with no header)', async () => {
        fsMock.readFile.mockResolvedValueOnce('stray_key = stray_value\n[existing_profile]\naws_access_key_id = OLD\n');
        await createSessionProfile('123456789012', creds());
        const written = fsMock.writeFile.mock.calls[0][1] as string;
        expect(written).toContain('[existing_profile]');
        expect(written).toContain('aws_access_key_id = OLD');
        expect(written).not.toContain('stray_key');
    });
});

describe('cleanupTenantCredentials', () => {
    beforeEach(() => vi.clearAllMocks());

    it('removes the tenant credentials directory', async () => {
        await cleanupTenantCredentials('tenant-1');
        expect(fsMock.rm).toHaveBeenCalledWith(expect.stringContaining('tenant-1'), { recursive: true, force: true });
    });

    it('logs but does not throw when removal fails', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        fsMock.rm.mockRejectedValueOnce(new Error('locked'));
        await expect(cleanupTenantCredentials('tenant-1')).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error removing tenant tenant-1'), expect.any(Error));
        errorSpy.mockRestore();
    });
});

describe('cleanupAllAgentProfiles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fsMock.rm.mockResolvedValue(undefined);
        fsMock.readFile.mockResolvedValue('');
    });

    it('removes the per-tenant credentials root and reports no stale profiles when the legacy file has none', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        fsMock.readFile.mockResolvedValueOnce('[user-profile]\naws_access_key_id = X\n');

        await cleanupAllAgentProfiles();

        expect(fsMock.rm).toHaveBeenCalledWith(expect.stringContaining('nucleus-aws-creds'), { recursive: true, force: true });
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No stale agent profiles found'));
        expect(fsMock.writeFile).not.toHaveBeenCalled();
        logSpy.mockRestore();
    });

    it('strips agent-prefixed profiles from the legacy file and leaves user profiles intact', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        fsMock.readFile.mockResolvedValueOnce(
            '[user-profile]\naws_access_key_id = KEEP\n[nucleus_agent_123_999_abc]\naws_access_key_id = DROP\n',
        );

        await cleanupAllAgentProfiles();

        const written = fsMock.writeFile.mock.calls[0][1] as string;
        expect(written).toContain('[user-profile]');
        expect(written).not.toContain('nucleus_agent_123_999_abc');
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Removed 1 stale agent profiles'));
        logSpy.mockRestore();
    });

    it('logs but does not throw when removing the per-tenant root fails', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        fsMock.rm.mockRejectedValueOnce(new Error('busy'));

        await expect(cleanupAllAgentProfiles()).resolves.toBeUndefined();

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error removing per-tenant credentials root'), expect.any(Error));
        errorSpy.mockRestore();
    });

    it('logs but does not throw when the legacy-file cleanup step itself fails', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        fsMock.readFile.mockRejectedValueOnce(new Error('permission denied'));

        await expect(cleanupAllAgentProfiles()).resolves.toBeUndefined();

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error during cleanup'), expect.any(Error));
        errorSpy.mockRestore();
    });
});
