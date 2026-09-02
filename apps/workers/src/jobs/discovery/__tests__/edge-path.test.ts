import { describe, it, expect } from 'vitest';
import { resolvePath, applyTransform } from '../services/edge-path.js';

describe('resolvePath', () => {
    it('resolves a scalar', () => {
        expect(resolvePath({ VpcId: 'vpc-1' }, 'VpcId')).toEqual(['vpc-1']);
    });

    it('resolves a nested scalar', () => {
        expect(resolvePath({ DBSubnetGroup: { VpcId: 'vpc-1' } }, 'DBSubnetGroup.VpcId')).toEqual(['vpc-1']);
    });

    it('fans out over an array of objects', () => {
        const raw = { SecurityGroups: [{ GroupId: 'sg-1' }, { GroupId: 'sg-2' }] };
        expect(resolvePath(raw, 'SecurityGroups[].GroupId')).toEqual(['sg-1', 'sg-2']);
    });

    it('fans out over an array of scalars', () => {
        const raw = { resourcesVpcConfig: { subnetIds: ['subnet-1', 'subnet-2'] } };
        expect(resolvePath(raw, 'resourcesVpcConfig.subnetIds[]')).toEqual(['subnet-1', 'subnet-2']);
    });

    it('resolves nested objects inside an array', () => {
        const raw = { BlockDeviceMappings: [{ Ebs: { VolumeId: 'vol-1' } }, { Ebs: { VolumeId: 'vol-2' } }] };
        expect(resolvePath(raw, 'BlockDeviceMappings[].Ebs.VolumeId')).toEqual(['vol-1', 'vol-2']);
    });

    it('returns empty for a missing path', () => {
        expect(resolvePath({ VpcId: 'vpc-1' }, 'SubnetId')).toEqual([]);
    });

    it('skips null and undefined entries', () => {
        const raw = { SecurityGroups: [{ GroupId: 'sg-1' }, { GroupId: null }, {}] };
        expect(resolvePath(raw, 'SecurityGroups[].GroupId')).toEqual(['sg-1']);
    });

    it('returns empty for non-object input', () => {
        expect(resolvePath('a-string', 'VpcId')).toEqual([]);
        expect(resolvePath(null, 'VpcId')).toEqual([]);
    });
});

describe('applyTransform', () => {
    it('returns the value unchanged with no transform', () => {
        expect(applyTransform('vpc-1')).toEqual(['vpc-1']);
    });

    it('takes the last ARN segment', () => {
        expect(applyTransform('arn:aws:iam::111:role/my-role', 'arn-last-segment')).toEqual(['my-role']);
        expect(applyTransform('arn:aws:kms:us-east-1:111:key/abc-def', 'arn-last-segment')).toEqual(['abc-def']);
    });

    it('takes the final segment of a pathed role ARN', () => {
        expect(applyTransform('arn:aws:iam::111:role/team/app-role', 'arn-last-segment')).toEqual(['app-role']);
    });

    it('leaves non-ARN values alone under arn-last-segment', () => {
        expect(applyTransform('abc-def-key-id', 'arn-last-segment')).toEqual(['abc-def-key-id']);
    });

    it('splits csv and trims', () => {
        expect(applyTransform('subnet-1, subnet-2', 'csv')).toEqual(['subnet-1', 'subnet-2']);
    });

    it('drops empty csv segments', () => {
        expect(applyTransform('subnet-1,,subnet-2,', 'csv')).toEqual(['subnet-1', 'subnet-2']);
    });
});
