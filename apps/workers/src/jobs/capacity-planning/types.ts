// workers/src/jobs/capacity-planning/types.ts

export type CapacityResourceType = 'ecs' | 'asg';

export interface ResourceToScan {
    resourceType: CapacityResourceType;
    resourceId: string;
    clusterName?: string;
    serviceName?: string;
    asgName?: string;
    /** ECS only — resolves installed vCPU/RAM via DescribeTaskDefinition. */
    taskDefinitionArn?: string;
}

export interface InstalledCapacity {
    vcpu?: number;
    memGiB?: number;
}

/** One hourly bucket for one resource, ready for db-writer.upsertSamples(). */
export interface CapacitySample {
    tenantId: string;
    accountId: string;
    region: string;
    resourceType: CapacityResourceType;
    resourceId: string;
    clusterName?: string;
    serviceName?: string;
    asgName?: string;
    bucketStartUtc: Date;
    cpuAvg?: number;
    cpuMax?: number;
    memAvg?: number;
    memMax?: number;
    installedVcpu?: number;
    installedMemGiB?: number;
}

export interface CapacityPlanningScanJob {
    tenantId: string;
    trigger: 'schedule' | 'manual';
    runId?: string;
}
