import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend, instances } = vi.hoisted(() => ({
    mockSend: vi.fn(),
    instances: [] as any[],
}));

function commandMock(commandName: string) {
    return vi.fn().mockImplementation(function (this: { input: unknown; commandName: string }, input: unknown) {
        this.input = input;
        this.commandName = commandName;
    });
}

vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: vi.fn().mockImplementation(function (this: { send: typeof mockSend; opts: unknown }, opts: unknown) {
        this.send = mockSend;
        this.opts = opts;
        instances.push(this);
    }),
    GetObjectCommand: commandMock('GetObjectCommand'),
    PutObjectCommand: commandMock('PutObjectCommand'),
    DeleteObjectCommand: commandMock('DeleteObjectCommand'),
}));

vi.mock('@/env', () => ({ env: { APP_BUCKET_NAME: 'nucleus-assets', AWS_REGION: 'ap-south-1' } }));

import {
    versionS3Prefix, putVersionMaterial, loadVersionMaterial, deleteMaterial, APP_BUCKET,
} from './certificate-material';

beforeEach(() => {
    vi.clearAllMocks();
    instances.length = 0;
});

describe('APP_BUCKET', () => {
    it('reads the bucket name from env', () => {
        expect(APP_BUCKET).toBe('nucleus-assets');
    });

    it('defaults to an empty string when APP_BUCKET_NAME is unset', async () => {
        vi.resetModules();
        vi.doMock('@aws-sdk/client-s3', () => ({
            S3Client: vi.fn().mockImplementation(function (this: { send: typeof mockSend }) { this.send = mockSend; }),
            GetObjectCommand: commandMock('GetObjectCommand'),
            PutObjectCommand: commandMock('PutObjectCommand'),
            DeleteObjectCommand: commandMock('DeleteObjectCommand'),
        }));
        vi.doMock('@/env', () => ({ env: { APP_BUCKET_NAME: undefined, AWS_REGION: undefined } }));
        const fresh = await import('./certificate-material');
        expect(fresh.APP_BUCKET).toBe('');
    });
});

describe('s3() region fallback', () => {
    it('defaults the S3 client region to ap-south-1 when AWS_REGION is unset', async () => {
        vi.resetModules();
        const freshInstances: any[] = [];
        vi.doMock('@aws-sdk/client-s3', () => ({
            S3Client: vi.fn().mockImplementation(function (this: { send: typeof mockSend; opts: unknown }, opts: unknown) {
                this.send = mockSend;
                this.opts = opts;
                freshInstances.push(this);
            }),
            GetObjectCommand: commandMock('GetObjectCommand'),
            PutObjectCommand: commandMock('PutObjectCommand'),
            DeleteObjectCommand: commandMock('DeleteObjectCommand'),
        }));
        vi.doMock('@/env', () => ({ env: { APP_BUCKET_NAME: 'nucleus-assets', AWS_REGION: undefined } }));

        const fresh = await import('./certificate-material');
        await fresh.deleteMaterial([]); // s3() is constructed even for an empty key list

        expect(freshInstances[0].opts).toEqual({ region: 'ap-south-1' });
    });
});

describe('versionS3Prefix', () => {
    it('builds the versioned prefix path', () => {
        expect(versionS3Prefix('tenant-1', 'cert-1', 3)).toBe('certificates/tenant-1/cert-1/v3');
    });
});

describe('putVersionMaterial', () => {
    it('uploads body and private key, and constructs the S3 client with the configured region', async () => {
        mockSend.mockResolvedValue({});
        const result = await putVersionMaterial('certificates/t1/c1/v1', {
            body: 'BODY PEM', privateKey: 'KEY PEM',
        });

        expect(instances[0].opts).toEqual({ region: 'ap-south-1' });
        expect(result).toEqual({
            s3BodyKey: 'certificates/t1/c1/v1/body.pem',
            s3ChainKey: null,
            s3PrivateKeyKey: 'certificates/t1/c1/v1/private.key',
        });

        const bodyCall = mockSend.mock.calls.find((c) => c[0].commandName === 'PutObjectCommand' && c[0].input.Key.endsWith('body.pem'));
        expect(bodyCall[0].input).toEqual({
            Bucket: 'nucleus-assets', Key: 'certificates/t1/c1/v1/body.pem', Body: 'BODY PEM', ContentType: 'application/x-pem-file',
        });
    });

    it('also uploads the chain when provided, and returns its key', async () => {
        mockSend.mockResolvedValue({});
        const result = await putVersionMaterial('certificates/t1/c1/v1', {
            body: 'BODY', privateKey: 'KEY', chain: 'CHAIN PEM',
        });

        expect(result.s3ChainKey).toBe('certificates/t1/c1/v1/chain.pem');
        const chainCall = mockSend.mock.calls.find((c) => c[0].commandName === 'PutObjectCommand' && c[0].input.Key.endsWith('chain.pem'));
        expect(chainCall[0].input.Body).toBe('CHAIN PEM');
    });

    it('does not send a chain PutObjectCommand when no chain is given', async () => {
        mockSend.mockResolvedValue({});
        await putVersionMaterial('certificates/t1/c1/v1', { body: 'BODY', privateKey: 'KEY' });
        const chainCalls = mockSend.mock.calls.filter((c) => c[0].input?.Key?.endsWith('chain.pem'));
        expect(chainCalls).toHaveLength(0);
    });
});

describe('loadVersionMaterial', () => {
    const transformToString = (s: string) => vi.fn().mockResolvedValue(s);

    it('reads body and private key by their stored keys', async () => {
        mockSend.mockImplementation((cmd: { input: { Key: string } }) => {
            if (cmd.input.Key === 'body-key') return Promise.resolve({ Body: { transformToString: transformToString('BODY') } });
            if (cmd.input.Key === 'priv-key') return Promise.resolve({ Body: { transformToString: transformToString('KEY') } });
            throw new Error(`unexpected key ${cmd.input.Key}`);
        });

        const result = await loadVersionMaterial({ s3BodyKey: 'body-key', s3ChainKey: null, s3PrivateKeyKey: 'priv-key' });

        expect(result).toEqual({ body: 'BODY', chain: undefined, privateKey: 'KEY' });
    });

    it('also reads the chain when s3ChainKey is set', async () => {
        mockSend.mockImplementation((cmd: { input: { Key: string } }) => {
            if (cmd.input.Key === 'body-key') return Promise.resolve({ Body: { transformToString: transformToString('BODY') } });
            if (cmd.input.Key === 'chain-key') return Promise.resolve({ Body: { transformToString: transformToString('CHAIN') } });
            if (cmd.input.Key === 'priv-key') return Promise.resolve({ Body: { transformToString: transformToString('KEY') } });
            throw new Error(`unexpected key ${cmd.input.Key}`);
        });

        const result = await loadVersionMaterial({ s3BodyKey: 'body-key', s3ChainKey: 'chain-key', s3PrivateKeyKey: 'priv-key' });

        expect(result.chain).toBe('CHAIN');
    });

    it('does not request the chain object when s3ChainKey is null', async () => {
        mockSend.mockImplementation((cmd: { input: { Key: string } }) => {
            return Promise.resolve({ Body: { transformToString: transformToString('x') } });
        });
        await loadVersionMaterial({ s3BodyKey: 'body-key', s3ChainKey: null, s3PrivateKeyKey: 'priv-key' });
        const keysRequested = mockSend.mock.calls.map((c) => c[0].input.Key);
        expect(keysRequested).toEqual(['body-key', 'priv-key']);
    });
});

describe('deleteMaterial', () => {
    it('deletes every non-null key', async () => {
        mockSend.mockResolvedValue({});
        await deleteMaterial(['key-1', 'key-2']);
        expect(mockSend).toHaveBeenCalledTimes(2);
        const deletedKeys = mockSend.mock.calls.map((c) => c[0].input.Key);
        expect(deletedKeys).toEqual(expect.arrayContaining(['key-1', 'key-2']));
    });

    it('filters out null and undefined entries', async () => {
        mockSend.mockResolvedValue({});
        await deleteMaterial(['key-1', null, undefined, 'key-2']);
        expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('is a no-op for an all-null/undefined list', async () => {
        await deleteMaterial([null, undefined]);
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('swallows a per-key delete failure rather than rejecting the whole batch', async () => {
        mockSend.mockImplementation((cmd: { input: { Key: string } }) =>
            cmd.input.Key === 'bad-key' ? Promise.reject(new Error('access denied')) : Promise.resolve({}),
        );
        await expect(deleteMaterial(['bad-key', 'good-key'])).resolves.toBeUndefined();
    });
});
