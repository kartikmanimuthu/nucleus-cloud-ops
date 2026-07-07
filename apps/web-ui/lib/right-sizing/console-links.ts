import { RESOURCE_TYPES, type ResourceTypeKey } from './types';

/**
 * Deep link into the AWS console for a resource, scoped to its own region. Points at the
 * *member* account's console — the viewer needs their own access to that account (e.g. via
 * AWS SSO) for the link to resolve; this is a convenience link, not an assumed-role hop.
 * Returns null for resource types without a known console URL shape.
 */
export function buildConsoleUrl(resourceType: string, region: string, resourceId: string): string | null {
    switch (resourceType as ResourceTypeKey) {
        case RESOURCE_TYPES.EC2:
            return `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${resourceId}`;
        case RESOURCE_TYPES.EBS:
            return `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#VolumeDetails:volumeId=${resourceId}`;
        case RESOURCE_TYPES.RDS:
            return `https://${region}.console.aws.amazon.com/rds/home?region=${region}#database:id=${resourceId};is-cluster=false`;
        case RESOURCE_TYPES.ASG:
            return `https://${region}.console.aws.amazon.com/ec2autoscaling/home?region=${region}#/details/${resourceId}`;
        default:
            return null;
    }
}
