// workers/src/jobs/spot-guard/services/ecs-client.test.ts
//
// Tests for the pure extractors in ecs-client. The AWS calls themselves are exercised by
// the sandbox smoke test; these two functions decide WHICH IP and WHICH port get
// deregistered from a load balancer, so getting them wrong would drain the wrong target.
import { describe, it, expect } from 'vitest';
import type { Service, Task } from '@aws-sdk/client-ecs';
import { extractTaskPrivateIp, resolveTargetGroups } from './ecs-client.js';

describe('extractTaskPrivateIp', () => {
    it('finds the private IPv4 on the awsvpc ENI attachment', () => {
        const task: Task = {
            attachments: [
                {
                    type: 'ElasticNetworkInterface',
                    details: [
                        { name: 'subnetId', value: 'subnet-1' },
                        { name: 'privateIPv4Address', value: '10.0.1.42' },
                    ],
                },
            ],
        };
        expect(extractTaskPrivateIp(task)).toBe('10.0.1.42');
    });

    it('ignores non-ENI attachments', () => {
        const task: Task = {
            attachments: [
                { type: 'Service Connect', details: [{ name: 'privateIPv4Address', value: '10.9.9.9' }] },
                { type: 'ElasticNetworkInterface', details: [{ name: 'privateIPv4Address', value: '10.0.1.7' }] },
            ],
        };
        // Taking the first match regardless of type would drain the wrong address.
        expect(extractTaskPrivateIp(task)).toBe('10.0.1.7');
    });

    it('returns null when the ENI has no private IP detail', () => {
        expect(extractTaskPrivateIp({ attachments: [{ type: 'ElasticNetworkInterface', details: [] }] })).toBeNull();
    });

    it('returns null for a task with no attachments at all', () => {
        // Happens once the ENI has already detached — ECS native draining still covers us.
        expect(extractTaskPrivateIp({})).toBeNull();
        expect(extractTaskPrivateIp({ attachments: [] })).toBeNull();
    });
});

describe('resolveTargetGroups', () => {
    it('reads target group and port from the service load balancer config', () => {
        const svc: Service = {
            loadBalancers: [{ targetGroupArn: 'arn:aws:elasticloadbalancing:::tg/a', containerPort: 8080 }],
        };
        expect(resolveTargetGroups(svc)).toEqual([
            { targetGroupArn: 'arn:aws:elasticloadbalancing:::tg/a', containerPort: 8080 },
        ]);
    });

    it('returns every target group for a multi-listener service', () => {
        const svc: Service = {
            loadBalancers: [
                { targetGroupArn: 'arn:aws:elasticloadbalancing:::tg/http', containerPort: 8080 },
                { targetGroupArn: 'arn:aws:elasticloadbalancing:::tg/grpc', containerPort: 9090 },
            ],
        };
        // Draining only the first would leave the dying task serving on the second.
        expect(resolveTargetGroups(svc)).toHaveLength(2);
    });

    it('skips entries missing an ARN or a port rather than emitting a partial target', () => {
        const svc: Service = {
            loadBalancers: [
                { targetGroupArn: 'arn:aws:elasticloadbalancing:::tg/ok', containerPort: 80 },
                { containerPort: 80 },
                { targetGroupArn: 'arn:aws:elasticloadbalancing:::tg/no-port' },
            ],
        };
        expect(resolveTargetGroups(svc)).toEqual([
            { targetGroupArn: 'arn:aws:elasticloadbalancing:::tg/ok', containerPort: 80 },
        ]);
    });

    it('treats containerPort 0 as present, not as missing', () => {
        // A falsy-but-valid value: `lb.containerPort &&` would wrongly drop this.
        const svc: Service = { loadBalancers: [{ targetGroupArn: 'arn:aws:elasticloadbalancing:::tg/z', containerPort: 0 }] };
        expect(resolveTargetGroups(svc)).toHaveLength(1);
    });

    it('returns empty for a service with no load balancer', () => {
        expect(resolveTargetGroups({})).toEqual([]);
        expect(resolveTargetGroups({ loadBalancers: [] })).toEqual([]);
    });
});
