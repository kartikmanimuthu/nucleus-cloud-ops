import { describe, it, expect } from 'vitest';
import { parseEcsServiceArn } from './db-writer.js';

describe('parseEcsServiceArn', () => {
    it('extracts cluster and service name from a service ARN', () => {
        expect(parseEcsServiceArn('arn:aws:ecs:ap-south-1:688849551607:service/stx-kyc-ekyc-ecs-fargate/stx-kyc-ekyc-admin-api')).toEqual({
            clusterName: 'stx-kyc-ekyc-ecs-fargate',
            serviceName: 'stx-kyc-ekyc-admin-api',
        });
    });

    it('returns null for the Application Auto Scaling short form (no ARN)', () => {
        expect(parseEcsServiceArn('service/my-cluster/my-svc')).toBeNull();
    });

    it('returns null for a non-ECS ARN', () => {
        expect(parseEcsServiceArn('arn:aws:autoscaling:ap-south-1:688849551607:autoScalingGroup:uuid:autoScalingGroupName/my-asg')).toBeNull();
    });
});
