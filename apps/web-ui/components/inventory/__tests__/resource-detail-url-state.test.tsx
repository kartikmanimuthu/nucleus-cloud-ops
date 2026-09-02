// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockPush = vi.fn();
let search = new URLSearchParams();

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: mockPush, replace: vi.fn() }),
    useSearchParams: () => search,
    usePathname: () => '/app/inventory',
}));

vi.mock('@/lib/tenant-context', () => ({
    useTenant: () => ({ timezone: 'UTC' }),
    TenantProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// jsdom lacks layout APIs Radix touches
beforeEach(() => {
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {});
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
    if (typeof (globalThis as any).ResizeObserver === 'undefined') {
        (globalThis as any).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
});

const mockFetch = vi.fn(async (url: string | Request) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('/api/inventory/resources/ec2_instances/i-1')) {
        return new Response(JSON.stringify({
            success: true,
            data: {
                resourceId: 'i-1',
                resourceArn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-1',
                resourceType: 'ec2_instances',
                name: 'MyInstance',
                region: 'us-east-1',
                state: 'running',
                accountId: '123456789012',
                accountName: 'TestAccount',
                lastDiscoveredAt: '2026-08-11T00:00:00.000Z',
                tags: {},
                metadata: {},
            },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlStr.includes('/api/inventory/resources?')) {
        return new Response(JSON.stringify({
            resources: [{
                resourceId: 'i-1',
                resourceArn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-1',
                resourceType: 'ec2_instances',
                name: 'MyInstance',
                region: 'us-east-1',
                state: 'running',
                accountId: '123456789012',
                accountName: 'TestAccount',
                lastDiscoveredAt: '2026-08-11T00:00:00.000Z',
                tags: {},
                metadata: {},
            }],
            total: 1,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlStr.includes('/api/inventory/status')) {
        return new Response(JSON.stringify({
            totalResources: 1,
            accountsSynced: 1,
            lastSyncedAt: '2026-08-11T00:00:00.000Z',
            latestSync: null,
            accounts: [],
            accountCount: 1,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlStr.includes('/api/accounts')) {
        return new Response(JSON.stringify({
            success: true,
            data: [],
            totalCount: 0,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 200 });
});

import InventoryPage from '../../../app/app/inventory/page';

function renderPage() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <InventoryPage />
        </QueryClientProvider>
    );
}

describe('inventory URL state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        search = new URLSearchParams();
        vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('restores the dialog from the URL on a cold load', async () => {
        search = new URLSearchParams('resource=ec2_instances:i-1&tab=dependencies');
        renderPage();

        expect(await screen.findByRole('dialog')).toBeTruthy();
    });

    it('pushes history when a resource is opened', async () => {
        renderPage();

        await waitFor(() => expect(screen.queryAllByRole('row').length).toBeGreaterThan(1));

        const rows = screen.queryAllByRole('row');
        // First row is the header; click the first data row
        fireEvent.click(rows[1]);

        expect(mockPush).toHaveBeenCalledWith(
            expect.stringContaining('resource=ec2_instances%3Ai-1'),
            expect.anything(),
        );
    });
});
