import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientAccountService } from './client-account-service';

const mockJson = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
});

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('getAccounts', () => {
    it('fetches the bare route when no filters are given', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, data: [], totalCount: 0 }) as any);
        await ClientAccountService.getAccounts();
        expect(fetch).toHaveBeenCalledWith('/api/accounts', expect.objectContaining({ method: 'GET' }));
    });

    it('appends every provided filter as a query parameter', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, data: [], totalCount: 0 }) as any);
        await ClientAccountService.getAccounts({
            statusFilter: 'active', connectionFilter: 'connected', searchTerm: 'prod', limit: 10, page: 2,
        });
        const url = vi.mocked(fetch).mock.calls[0][0] as string;
        expect(url).toContain('status=active');
        expect(url).toContain('connection=connected');
        expect(url).toContain('search=prod');
        expect(url).toContain('limit=10');
        expect(url).toContain('page=2');
    });

    it('returns accounts and totalCount, defaulting totalCount to 0 when omitted', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, data: [{ id: 'a1' }] }) as any);
        const result = await ClientAccountService.getAccounts();
        expect(result).toEqual({ accounts: [{ id: 'a1' }], totalCount: 0 });
    });

    it('throws the server error message on a non-ok response', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ error: 'boom' }, 500) as any);
        await expect(ClientAccountService.getAccounts()).rejects.toThrow('boom');
    });

    it('falls back to a generic HTTP-status message when the error body has none', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({}, 500) as any);
        await expect(ClientAccountService.getAccounts()).rejects.toThrow('HTTP error! status: 500');
    });

    it('throws when the response is ok but success is false', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: false, error: 'denied' }) as any);
        await expect(ClientAccountService.getAccounts()).rejects.toThrow('denied');
    });

    it('falls back to a generic message when success is false with no error text', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: false }) as any);
        await expect(ClientAccountService.getAccounts()).rejects.toThrow('Failed to fetch accounts');
    });

    it('propagates a network-level fetch rejection', async () => {
        vi.mocked(fetch).mockRejectedValue(new Error('network down'));
        await expect(ClientAccountService.getAccounts()).rejects.toThrow('network down');
    });
});

describe('getAccount', () => {
    it('URL-encodes the account id in the path', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, data: { id: 'a/1' } }) as any);
        await ClientAccountService.getAccount('a/1');
        expect(fetch).toHaveBeenCalledWith('/api/accounts/a%2F1', expect.objectContaining({ method: 'GET' }));
    });

    it('returns null on a 404 without throwing', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ error: 'not found' }, 404) as any);
        expect(await ClientAccountService.getAccount('missing')).toBeNull();
    });

    it('returns the account data on success', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, data: { id: 'a1', name: 'Prod' } }) as any);
        const result = await ClientAccountService.getAccount('a1');
        expect(result).toEqual({ id: 'a1', name: 'Prod' });
    });

    it('throws on a non-404, non-ok response', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ error: 'server error' }, 500) as any);
        await expect(ClientAccountService.getAccount('a1')).rejects.toThrow('server error');
    });

    it('falls back to a generic HTTP-status message on a non-ok response with no error text', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({}, 500) as any);
        await expect(ClientAccountService.getAccount('a1')).rejects.toThrow('HTTP error! status: 500');
    });

    it('throws when the response is ok but success is false', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: false }) as any);
        await expect(ClientAccountService.getAccount('a1')).rejects.toThrow('Failed to fetch account');
    });
});

describe('createAccount', () => {
    const INPUT = { name: 'Prod', accountId: 'a1', roleArn: 'arn:aws:iam::1:role/R', regions: ['us-east-1'], active: true };

    it('POSTs the account payload to the base route', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true }) as any);
        await ClientAccountService.createAccount(INPUT);
        expect(fetch).toHaveBeenCalledWith('/api/accounts', expect.objectContaining({
            method: 'POST', body: JSON.stringify(INPUT),
        }));
    });

    it('throws the server error on failure', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ error: 'invalid role' }, 400) as any);
        await expect(ClientAccountService.createAccount(INPUT)).rejects.toThrow('invalid role');
    });

    it('falls back to a generic HTTP-status message on a non-ok response with no error text', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({}, 400) as any);
        await expect(ClientAccountService.createAccount(INPUT)).rejects.toThrow('HTTP error! status: 400');
    });

    it('throws a generic message when ok but success is false with no error text', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: false }) as any);
        await expect(ClientAccountService.createAccount(INPUT)).rejects.toThrow('Failed to create account');
    });
});

describe('updateAccount', () => {
    it('PUTs to the account-scoped route', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true }) as any);
        await ClientAccountService.updateAccount('a1', { name: 'New' });
        expect(fetch).toHaveBeenCalledWith('/api/accounts/a1', expect.objectContaining({
            method: 'PUT', body: JSON.stringify({ name: 'New' }),
        }));
    });

    it('throws the server error on failure', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ error: 'conflict' }, 409) as any);
        await expect(ClientAccountService.updateAccount('a1', {})).rejects.toThrow('conflict');
    });

    it('falls back to a generic HTTP-status message on a non-ok response with no error text', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({}, 409) as any);
        await expect(ClientAccountService.updateAccount('a1', {})).rejects.toThrow('HTTP error! status: 409');
    });

    it('throws a generic message when ok but success is false with no error text', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: false }) as any);
        await expect(ClientAccountService.updateAccount('a1', {})).rejects.toThrow('Failed to update account');
    });
});

describe('deleteAccount', () => {
    it('DELETEs the account-scoped route', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true }) as any);
        await ClientAccountService.deleteAccount('a1');
        expect(fetch).toHaveBeenCalledWith('/api/accounts/a1', expect.objectContaining({ method: 'DELETE' }));
    });

    it('throws the server error on failure', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ error: 'cannot delete' }, 400) as any);
        await expect(ClientAccountService.deleteAccount('a1')).rejects.toThrow('cannot delete');
    });

    it('falls back to a generic HTTP-status message on a non-ok response with no error text', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({}, 400) as any);
        await expect(ClientAccountService.deleteAccount('a1')).rejects.toThrow('HTTP error! status: 400');
    });

    it('throws a generic message when ok but success is false with no error text', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: false }) as any);
        await expect(ClientAccountService.deleteAccount('a1')).rejects.toThrow('Failed to delete account');
    });
});

describe('validateAccount', () => {
    it('posts to the account-scoped validate route when no roleArn is supplied', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ valid: true, data: { connectionError: 'None' } }) as any);
        await ClientAccountService.validateAccount({ accountId: 'a1', region: 'us-east-1' });
        expect(fetch).toHaveBeenCalledWith('/api/accounts/a1/validate', expect.objectContaining({ body: '{}' }));
    });

    it('posts to the global validate route with the full credential payload when roleArn is supplied', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ valid: true, data: {} }) as any);
        await ClientAccountService.validateAccount({
            accountId: 'a1', region: 'us-east-1', roleArn: 'arn:aws:iam::1:role/R', externalId: 'ext-1',
        });
        expect(fetch).toHaveBeenCalledWith('/api/accounts/validate', expect.objectContaining({
            body: JSON.stringify({ accountId: 'a1', roleArn: 'arn:aws:iam::1:role/R', externalId: 'ext-1', region: 'us-east-1' }),
        }));
    });

    it('returns isValid:false with the server error on a non-ok response, without throwing', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ error: 'access denied' }, 403) as any);
        const result = await ClientAccountService.validateAccount({ accountId: 'a1', region: 'us-east-1' });
        expect(result).toEqual({ isValid: false, error: 'access denied' });
    });

    it('falls back to a generic HTTP-status message on a non-ok response with no error text', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({}, 500) as any);
        const result = await ClientAccountService.validateAccount({ accountId: 'a1', region: 'us-east-1' });
        expect(result.error).toBe('HTTP error! status: 500');
    });

    it('maps the persistent-endpoint shape (result.valid) and surfaces a real connectionError', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ valid: false, data: { connectionError: 'timed out' } }) as any);
        const result = await ClientAccountService.validateAccount({ accountId: 'a1', region: 'us-east-1' });
        expect(result).toEqual({ isValid: false, error: 'timed out' });
    });

    it('treats connectionError "None" as no error on the persistent-endpoint shape', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ valid: true, data: { connectionError: 'None' } }) as any);
        const result = await ClientAccountService.validateAccount({ accountId: 'a1', region: 'us-east-1' });
        expect(result).toEqual({ isValid: true, error: undefined });
    });

    it('falls back to result.data for the global/ephemeral endpoint shape', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ data: { isValid: true } }) as any);
        const result = await ClientAccountService.validateAccount({
            accountId: 'a1', region: 'us-east-1', roleArn: 'arn:aws:iam::1:role/R',
        });
        expect(result).toEqual({ isValid: true });
    });

    it('reports a generic validation error when the ephemeral endpoint returns no data', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({}) as any);
        const result = await ClientAccountService.validateAccount({
            accountId: 'a1', region: 'us-east-1', roleArn: 'arn:aws:iam::1:role/R',
        });
        expect(result).toEqual({ isValid: false, error: 'Unknown validation error' });
    });

    it('catches a thrown network error and reports it as an invalid result rather than throwing', async () => {
        vi.mocked(fetch).mockRejectedValue(new Error('network down'));
        const result = await ClientAccountService.validateAccount({ accountId: 'a1', region: 'us-east-1' });
        expect(result).toEqual({ isValid: false, error: 'network down' });
    });

    it('reports a generic message for a non-Error throw', async () => {
        vi.mocked(fetch).mockRejectedValue('boom');
        const result = await ClientAccountService.validateAccount({ accountId: 'a1', region: 'us-east-1' });
        expect(result).toEqual({ isValid: false, error: 'Validation failed' });
    });
});

describe('scanResources', () => {
    it('GETs the account-scoped scan route', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, data: [] }) as any);
        await ClientAccountService.scanResources('a1');
        expect(fetch).toHaveBeenCalledWith('/api/accounts/a1/scan', expect.objectContaining({ method: 'GET' }));
    });

    it('returns the scanned resources on success', async () => {
        const resources = [{ id: 'i-1', type: 'ec2', name: 'i-1', arn: 'arn:aws:ec2:x' }];
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: true, data: resources }) as any);
        expect(await ClientAccountService.scanResources('a1')).toEqual(resources);
    });

    it('throws the server error on failure', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ error: 'scan failed' }, 500) as any);
        await expect(ClientAccountService.scanResources('a1')).rejects.toThrow('scan failed');
    });

    it('falls back to a generic HTTP-status message on a non-ok response with no error text', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({}, 500) as any);
        await expect(ClientAccountService.scanResources('a1')).rejects.toThrow('HTTP error! status: 500');
    });

    it('throws a generic message when ok but success is false with no error text', async () => {
        vi.mocked(fetch).mockResolvedValue(mockJson({ success: false }) as any);
        await expect(ClientAccountService.scanResources('a1')).rejects.toThrow('Failed to scan resources');
    });
});
