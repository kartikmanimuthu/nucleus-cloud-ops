/**
 * NetworkLinksService
 *
 * Business logic for the Scale Sentinel "Direct Connect & VPN" compliance
 * report. Delegates persistence to the repository factory (read-only — see
 * INetworkLinksRepository).
 */
import { getNetworkLinksRepository } from '@/lib/db/repository-factory';
import type { NetworkLinkSample, NetworkLinkSampleFilters } from '@/lib/db/repositories/network-links/interface';

export class NetworkLinksService {
    static async listSamples(tenantId: string, filters: NetworkLinkSampleFilters): Promise<NetworkLinkSample[]> {
        return getNetworkLinksRepository().listSamples(tenantId, filters);
    }
}
