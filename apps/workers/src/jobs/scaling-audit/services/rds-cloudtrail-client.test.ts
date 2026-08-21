import { describe, it, expect } from 'vitest';
import { classifyRdsCloudTrailEvent } from './rds-cloudtrail-client.js';

describe('classifyRdsCloudTrailEvent — ModifyDBInstance', () => {
    it('captures an instance-class change', () => {
        const result = classifyRdsCloudTrailEvent('ModifyDBInstance', {
            dBInstanceIdentifier: 'my-db',
            dBInstanceClass: 'db.r6g.xlarge',
        });
        expect(result?.resourceId).toBe('my-db');
        expect(result?.description).toContain('instance class -> db.r6g.xlarge');
    });

    it('captures a manual storage bump', () => {
        const result = classifyRdsCloudTrailEvent('ModifyDBInstance', {
            dBInstanceIdentifier: 'my-db',
            allocatedStorage: 500,
        });
        expect(result?.resourceId).toBe('my-db');
        expect(result?.description).toContain('allocated storage -> 500 GiB');
    });

    it('captures both when a single call changes class and storage', () => {
        const result = classifyRdsCloudTrailEvent('ModifyDBInstance', {
            dBInstanceIdentifier: 'my-db',
            dBInstanceClass: 'db.r6g.2xlarge',
            allocatedStorage: 1000,
        });
        expect(result?.description).toContain('instance class -> db.r6g.2xlarge');
        expect(result?.description).toContain('allocated storage -> 1000 GiB');
    });

    it('returns null when the call touches neither field — not a capacity change', () => {
        // e.g. rotating the master password, or changing a security group.
        expect(classifyRdsCloudTrailEvent('ModifyDBInstance', { dBInstanceIdentifier: 'my-db', masterUserPassword: '****' })).toBeNull();
    });

    it('returns null when no DB instance is named', () => {
        expect(classifyRdsCloudTrailEvent('ModifyDBInstance', { dBInstanceClass: 'db.r6g.xlarge' })).toBeNull();
        expect(classifyRdsCloudTrailEvent('ModifyDBInstance', undefined)).toBeNull();
    });
});

describe('classifyRdsCloudTrailEvent — CreateDBInstanceReadReplica', () => {
    it('names the new replica as resourceId and the source in the description', () => {
        const result = classifyRdsCloudTrailEvent('CreateDBInstanceReadReplica', {
            dBInstanceIdentifier: 'my-db-replica-1',
            sourceDBInstanceIdentifier: 'my-db',
        });
        expect(result?.resourceId).toBe('my-db-replica-1');
        expect(result?.description).toBe('Read replica added (source: my-db).');
    });

    it('still captures the replica when the source is somehow absent', () => {
        const result = classifyRdsCloudTrailEvent('CreateDBInstanceReadReplica', { dBInstanceIdentifier: 'my-db-replica-1' });
        expect(result?.description).toBe('Read replica added.');
    });
});

describe('classifyRdsCloudTrailEvent — DeleteDBInstance (best-effort primary-vs-replica)', () => {
    it('captures every deletion — CloudTrail carries no field distinguishing a replica from a primary', () => {
        const result = classifyRdsCloudTrailEvent('DeleteDBInstance', { dBInstanceIdentifier: 'my-db' });
        expect(result?.resourceId).toBe('my-db');
        expect(result?.description).toContain('primary or read replica');
    });
});

describe('classifyRdsCloudTrailEvent — out-of-scope event names', () => {
    it('returns null for anything not in the watched set', () => {
        expect(classifyRdsCloudTrailEvent('RebootDBInstance', { dBInstanceIdentifier: 'my-db' })).toBeNull();
        expect(classifyRdsCloudTrailEvent('CreateDBSnapshot', { dBInstanceIdentifier: 'my-db' })).toBeNull();
    });
});
