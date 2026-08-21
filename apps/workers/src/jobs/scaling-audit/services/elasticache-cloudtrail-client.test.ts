import { describe, it, expect } from 'vitest';
import { matchElastiCacheCapacityChange } from './elasticache-cloudtrail-client.js';

describe('matchElastiCacheCapacityChange — ModifyCacheCluster (Memcached-style clusters)', () => {
    it('matches a NumCacheNodes change', () => {
        const match = matchElastiCacheCapacityChange('ModifyCacheCluster', {
            cacheClusterId: 'my-memcached',
            applyImmediately: true,
            numCacheNodes: 3,
        });
        expect(match).toEqual({ resourceId: 'my-memcached', description: 'Setting NumCacheNodes to 3.' });
    });

    it('matches a CacheNodeType change (vertical scaling)', () => {
        const match = matchElastiCacheCapacityChange('ModifyCacheCluster', {
            cacheClusterId: 'my-memcached',
            cacheNodeType: 'cache.m5.xlarge',
        });
        expect(match).toEqual({ resourceId: 'my-memcached', description: 'Setting CacheNodeType to cache.m5.xlarge.' });
    });

    it('combines both when a single call changes node count AND node type', () => {
        const match = matchElastiCacheCapacityChange('ModifyCacheCluster', {
            cacheClusterId: 'my-memcached',
            numCacheNodes: 5,
            cacheNodeType: 'cache.m5.xlarge',
        });
        expect(match?.description).toBe('Setting NumCacheNodes to 5 and CacheNodeType to cache.m5.xlarge.');
    });

    it('is not a capacity change when only maintenance/parameter-group fields are touched', () => {
        expect(
            matchElastiCacheCapacityChange('ModifyCacheCluster', {
                cacheClusterId: 'my-memcached',
                preferredMaintenanceWindow: 'sun:23:00-mon:01:30',
                cacheParameterGroupName: 'default.memcached1.6',
            })
        ).toBeNull();
    });

    it('returns null when no cluster is named', () => {
        expect(matchElastiCacheCapacityChange('ModifyCacheCluster', { numCacheNodes: 3 })).toBeNull();
        expect(matchElastiCacheCapacityChange('ModifyCacheCluster', undefined)).toBeNull();
    });
});

describe('matchElastiCacheCapacityChange — ModifyReplicationGroup (Redis/Valkey-style)', () => {
    // The only capacity-relevant field on this call — NOT NumNodeGroups (that
    // is a different API, ModifyReplicationGroupShardConfiguration, tested
    // below). Getting this wrong would either miss real vertical scales or
    // silently no-op on a field this call doesn't have.
    it('matches a CacheNodeType change', () => {
        const match = matchElastiCacheCapacityChange('ModifyReplicationGroup', {
            replicationGroupId: 'my-repl-group',
            cacheNodeType: 'cache.r6g.xlarge',
        });
        expect(match).toEqual({ resourceId: 'my-repl-group', description: 'Setting CacheNodeType to cache.r6g.xlarge.' });
    });

    it('is not a capacity change when only non-capacity fields are touched (e.g. AuthToken rotation, failover flag)', () => {
        expect(
            matchElastiCacheCapacityChange('ModifyReplicationGroup', {
                replicationGroupId: 'my-repl-group',
                automaticFailoverEnabled: true,
                authTokenUpdateStrategy: 'ROTATE',
            })
        ).toBeNull();
    });

    it('a bare NumNodeGroups-shaped param is never checked — this call has no such field', () => {
        // Guards against ever "fixing" this to look for NumNodeGroups, which
        // would be reintroducing the very mistake this file's design note warns
        // about — that parameter simply does not exist on ModifyReplicationGroup.
        expect(
            matchElastiCacheCapacityChange('ModifyReplicationGroup', {
                replicationGroupId: 'my-repl-group',
                numNodeGroups: 4, // not a real ModifyReplicationGroup param — must be ignored
            })
        ).toBeNull();
    });
});

describe('matchElastiCacheCapacityChange — ModifyReplicationGroupShardConfiguration (shard count)', () => {
    it('matches a NodeGroupCount change', () => {
        const match = matchElastiCacheCapacityChange('ModifyReplicationGroupShardConfiguration', {
            replicationGroupId: 'my-repl-group',
            applyImmediately: true,
            nodeGroupCount: 4,
        });
        expect(match).toEqual({ resourceId: 'my-repl-group', description: 'Setting node group (shard) count to 4.' });
    });

    it('returns null without a resolved node group count', () => {
        expect(
            matchElastiCacheCapacityChange('ModifyReplicationGroupShardConfiguration', {
                replicationGroupId: 'my-repl-group',
                applyImmediately: true,
            })
        ).toBeNull();
    });
});

describe('matchElastiCacheCapacityChange — IncreaseReplicaCount / DecreaseReplicaCount', () => {
    it('matches a top-level NewReplicaCount (cluster-mode-disabled)', () => {
        expect(
            matchElastiCacheCapacityChange('IncreaseReplicaCount', {
                replicationGroupId: 'my-repl-group',
                newReplicaCount: 3,
            })
        ).toEqual({ resourceId: 'my-repl-group', description: 'Setting replica count to 3.' });

        expect(
            matchElastiCacheCapacityChange('DecreaseReplicaCount', {
                replicationGroupId: 'my-repl-group',
                newReplicaCount: 1,
            })
        ).toEqual({ resourceId: 'my-repl-group', description: 'Setting replica count to 1.' });
    });

    it('matches a per-shard ReplicaConfiguration array (cluster-mode-enabled) even with no top-level count', () => {
        const match = matchElastiCacheCapacityChange('IncreaseReplicaCount', {
            replicationGroupId: 'my-repl-group',
            replicaConfiguration: [{ nodeGroupId: '0001', newReplicaCount: 2 }],
        });
        expect(match).toEqual({ resourceId: 'my-repl-group', description: 'Setting replica count per shard.' });
    });

    it('returns null when neither a top-level count nor a per-shard config is present', () => {
        expect(
            matchElastiCacheCapacityChange('IncreaseReplicaCount', { replicationGroupId: 'my-repl-group', applyImmediately: true })
        ).toBeNull();
    });

    it('an empty ReplicaConfiguration array does not count as per-shard config', () => {
        expect(
            matchElastiCacheCapacityChange('DecreaseReplicaCount', {
                replicationGroupId: 'my-repl-group',
                replicaConfiguration: [],
            })
        ).toBeNull();
    });
});

describe('matchElastiCacheCapacityChange — unwatched event names', () => {
    it('returns null for anything outside the watched set (e.g. a parameter-group or snapshot call)', () => {
        expect(matchElastiCacheCapacityChange('ModifyCacheParameterGroup', { cacheParameterGroupName: 'x' })).toBeNull();
        expect(matchElastiCacheCapacityChange('CreateSnapshot', { cacheClusterId: 'x' })).toBeNull();
        expect(matchElastiCacheCapacityChange(undefined, { cacheClusterId: 'x' })).toBeNull();
    });
});
