import { describe, it, expect } from 'vitest';
import { clusterNameFromArn, mapOperationState, toRawActivity, WATCHED_OPERATION_TYPES } from './msk-operations-client.js';
import { isTerminalStatus } from './watermark.js';
import type { ClusterOperationV2Summary } from '@aws-sdk/client-kafka';

const CLUSTER_ARN = 'arn:aws:kafka:ap-south-1:123456789012:cluster/my-cluster/abcd1234-abcd-1234-abcd-1234567890ab-2';

function op(partial: Partial<ClusterOperationV2Summary>): ClusterOperationV2Summary {
    return {
        ClusterArn: CLUSTER_ARN,
        OperationArn: 'arn:aws:kafka:ap-south-1:123456789012:cluster-operation/my-cluster/abcd/op-1',
        OperationType: 'INCREASE_BROKER_COUNT',
        OperationState: 'UPDATE_COMPLETE',
        StartTime: new Date('2026-01-01T00:00:00Z'),
        ...partial,
    };
}

describe('clusterNameFromArn', () => {
    it('extracts the cluster name embedded in the ARN', () => {
        expect(clusterNameFromArn(CLUSTER_ARN)).toBe('my-cluster');
    });

    it('returns undefined for a non-cluster ARN', () => {
        expect(clusterNameFromArn('arn:aws:kafka:ap-south-1:123456789012:cluster-operation/my-cluster/abcd/op-1')).toBeUndefined();
    });

    it('returns undefined for a malformed string', () => {
        expect(clusterNameFromArn('not-an-arn')).toBeUndefined();
    });
});

describe('mapOperationState — feeds watermark.ts terminal detection for free', () => {
    it('maps UPDATE_COMPLETE to the exact string Successful', () => {
        expect(mapOperationState('UPDATE_COMPLETE')).toBe('Successful');
        expect(isTerminalStatus(mapOperationState('UPDATE_COMPLETE'))).toBe(true);
    });

    it('maps UPDATE_FAILED to the exact string Failed', () => {
        expect(mapOperationState('UPDATE_FAILED')).toBe('Failed');
        expect(isTerminalStatus(mapOperationState('UPDATE_FAILED'))).toBe(true);
    });

    it.each(['PENDING', 'UPDATE_IN_PROGRESS', 'SOME_FUTURE_STATE'])('passes %s through unchanged, held as non-terminal', (state) => {
        expect(mapOperationState(state)).toBe(state);
        expect(isTerminalStatus(mapOperationState(state))).toBe(false);
    });

    it('passes undefined through — isTerminalStatus(undefined) is false, never a crash', () => {
        expect(mapOperationState(undefined)).toBeUndefined();
        expect(isTerminalStatus(mapOperationState(undefined))).toBe(false);
    });
});

describe('WATCHED_OPERATION_TYPES — the decided MSK scope, nothing else', () => {
    it('covers broker count (both directions), storage, and instance type', () => {
        expect(WATCHED_OPERATION_TYPES.has('INCREASE_BROKER_COUNT')).toBe(true);
        expect(WATCHED_OPERATION_TYPES.has('DECREASE_BROKER_COUNT')).toBe(true);
        expect(WATCHED_OPERATION_TYPES.has('UPDATE_BROKER_STORAGE')).toBe(true);
        expect(WATCHED_OPERATION_TYPES.has('UPDATE_BROKER_TYPE')).toBe(true);
    });

    it('excludes out-of-scope operation types (config/version/lifecycle changes)', () => {
        expect(WATCHED_OPERATION_TYPES.has('UPDATE_CLUSTER_CONFIGURATION')).toBe(false);
        expect(WATCHED_OPERATION_TYPES.has('UPDATE_CLUSTER_KAFKA_VERSION')).toBe(false);
        expect(WATCHED_OPERATION_TYPES.has('CREATE_CLUSTER')).toBe(false);
        expect(WATCHED_OPERATION_TYPES.has('DELETE_CLUSTER')).toBe(false);
    });
});

describe('toRawActivity', () => {
    it('prefers the cluster name over the ARN for resourceId when known', () => {
        const activity = toRawActivity(op({}), 'my-cluster');
        expect(activity?.resourceId).toBe('my-cluster');
        expect(activity?.clusterName).toBe('my-cluster');
    });

    it('falls back to the cluster ARN when the name is unknown', () => {
        const activity = toRawActivity(op({}), undefined);
        expect(activity?.resourceId).toBe(CLUSTER_ARN);
    });

    it('uses the operation ARN as activityId — stable, unique, natural dedup key', () => {
        const activity = toRawActivity(op({ OperationArn: 'arn:op-xyz' }), 'my-cluster');
        expect(activity?.activityId).toBe('arn:op-xyz');
    });

    it('always sets scalingTypeOverride to direct_api, never manual', () => {
        const activity = toRawActivity(op({}), 'my-cluster');
        expect(activity?.scalingTypeOverride).toBe('direct_api');
    });

    it('writes a readable cause naming the operation type and cluster', () => {
        const activity = toRawActivity(op({ OperationType: 'UPDATE_BROKER_STORAGE' }), 'my-cluster');
        expect(activity?.cause).toBe('MSK UPDATE_BROKER_STORAGE on cluster my-cluster');
    });

    it('translates OperationState through mapOperationState', () => {
        const activity = toRawActivity(op({ OperationState: 'UPDATE_FAILED' }), 'my-cluster');
        expect(activity?.statusCode).toBe('Failed');
    });

    it('leaves an in-progress OperationState as its native string (non-terminal, held by watermark.ts)', () => {
        const activity = toRawActivity(op({ OperationState: 'UPDATE_IN_PROGRESS' }), 'my-cluster');
        expect(activity?.statusCode).toBe('UPDATE_IN_PROGRESS');
        expect(isTerminalStatus(activity?.statusCode)).toBe(false);
    });

    it.each([
        ['missing OperationArn', { OperationArn: undefined }],
        ['missing OperationType', { OperationType: undefined }],
        ['missing StartTime', { StartTime: undefined }],
        ['missing ClusterArn', { ClusterArn: undefined }],
    ])('returns null when %s — cannot build a valid activity', (_label, partial) => {
        expect(toRawActivity(op(partial), 'my-cluster')).toBeNull();
    });
});
