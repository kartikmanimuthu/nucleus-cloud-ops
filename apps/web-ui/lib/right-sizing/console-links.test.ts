import { describe, it, expect } from 'vitest';
import { buildConsoleUrl } from './console-links';
import { RESOURCE_TYPES } from './types';

describe('buildConsoleUrl', () => {
    it('builds an EC2 instance console URL', () => {
        expect(buildConsoleUrl(RESOURCE_TYPES.EC2, 'ap-south-1', 'i-0a9cb077870bea18b')).toBe(
            'https://ap-south-1.console.aws.amazon.com/ec2/home?region=ap-south-1#InstanceDetails:instanceId=i-0a9cb077870bea18b'
        );
    });

    it('builds an EBS volume console URL', () => {
        expect(buildConsoleUrl(RESOURCE_TYPES.EBS, 'ap-south-1', 'vol-0569512768763aa4c')).toBe(
            'https://ap-south-1.console.aws.amazon.com/ec2/home?region=ap-south-1#VolumeDetails:volumeId=vol-0569512768763aa4c'
        );
    });

    it('builds an RDS instance console URL', () => {
        expect(buildConsoleUrl(RESOURCE_TYPES.RDS, 'ap-south-1', 'db-prod-1')).toBe(
            'https://ap-south-1.console.aws.amazon.com/rds/home?region=ap-south-1#database:id=db-prod-1;is-cluster=false'
        );
    });

    it('builds an ASG console URL', () => {
        expect(buildConsoleUrl(RESOURCE_TYPES.ASG, 'ap-south-1', 'my-asg')).toBe(
            'https://ap-south-1.console.aws.amazon.com/ec2autoscaling/home?region=ap-south-1#/details/my-asg'
        );
    });

    it('returns null for an unknown resource type', () => {
        expect(buildConsoleUrl('unknown_type', 'ap-south-1', 'x-1')).toBeNull();
    });
});
