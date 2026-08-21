// workers/src/jobs/capacity-planning/services/ecs-capacity-client.ts
//
// Installed capacity (vCPU/RAM) for ECS services. Inventory already stores the
// service's taskDefinition ARN (pg-writer.ts ecs_services mapping) but not its
// cpu/memory — those live on the task definition itself, so one
// DescribeTaskDefinition call per unique ARN is unavoidable. Callers should
// dedupe ARNs across a poll batch first (many services share a family/revision)
// since this has no cache of its own.
import { ECSClient, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { createLogger } from '../../../lib/logger.js';
import type { AssumedCredentials } from '../../discovery/types.js';
import type { InstalledCapacity } from '../types.js';

const log = createLogger('capacity-planning-ecs-client');

/** ECS reports cpu in "CPU units" (1024 = 1 vCPU) and memory in MiB. */
function parseTaskSize(cpu?: string, memory?: string): InstalledCapacity {
    const cpuUnits = Number(cpu);
    const memMiB = Number(memory);
    return {
        vcpu: Number.isFinite(cpuUnits) && cpuUnits > 0 ? cpuUnits / 1024 : undefined,
        memGiB: Number.isFinite(memMiB) && memMiB > 0 ? memMiB / 1024 : undefined,
    };
}

/** Resolves installed capacity for a set of task definition ARNs. Never throws
 *  per-ARN — a lookup failure just leaves that resource's installed capacity
 *  unset, same as AWS having no data for it. */
export async function fetchInstalledCapacity(
    taskDefinitionArns: string[],
    assumed: AssumedCredentials,
    region: string
): Promise<Map<string, InstalledCapacity>> {
    const result = new Map<string, InstalledCapacity>();
    const unique = [...new Set(taskDefinitionArns)];
    if (!unique.length) return result;

    const ecs = new ECSClient({
        region,
        credentials: assumed.credentials?.accessKeyId
            ? {
                  accessKeyId: assumed.credentials.accessKeyId,
                  secretAccessKey: assumed.credentials.secretAccessKey,
                  sessionToken: assumed.credentials.sessionToken,
              }
            : undefined,
    });

    await Promise.all(
        unique.map(async (arn) => {
            try {
                const res = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }));
                result.set(arn, parseTaskSize(res.taskDefinition?.cpu, res.taskDefinition?.memory));
            } catch (err) {
                log.warn('DescribeTaskDefinition failed — installed capacity left unset', { arn, error: String(err) });
            }
        })
    );
    return result;
}
