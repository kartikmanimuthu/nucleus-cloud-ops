import { describe, it, expect } from 'vitest';
import { docDbResourceId } from './docdb-cloudtrail-client.js';

describe('docDbResourceId — decided scope filter (mirrors ecsResourceId in cloudtrail-client.ts)', () => {
    describe('ModifyDBInstance', () => {
        it('keeps a call that changed the instance class', () => {
            const result = docDbResourceId('ModifyDBInstance', { dBInstanceIdentifier: 'my-docdb-instance', dBInstanceClass: 'db.r6g.large' });
            expect(result).toEqual({ resourceId: 'my-docdb-instance', detail: 'db.r6g.large' });
        });

        it('drops a modify that did not touch the instance class — e.g. a maintenance-window or password change', () => {
            expect(docDbResourceId('ModifyDBInstance', { dBInstanceIdentifier: 'my-docdb-instance', preferredMaintenanceWindow: 'sun:05:00-sun:05:30' })).toBeNull();
        });

        it('drops a call missing the instance identifier', () => {
            expect(docDbResourceId('ModifyDBInstance', { dBInstanceClass: 'db.r6g.large' })).toBeNull();
        });
    });

    describe('CreateDBInstance', () => {
        it('keeps a call whose engine is docdb — the one reliable RDS/DocumentDB discriminator', () => {
            const result = docDbResourceId('CreateDBInstance', { dBInstanceIdentifier: 'my-docdb-replica', engine: 'docdb', dBInstanceClass: 'db.r6g.large' });
            expect(result).toEqual({ resourceId: 'my-docdb-replica', detail: 'db.r6g.large' });
        });

        it('drops a call whose engine is NOT docdb — the exact RDS collision this file exists to avoid', () => {
            expect(docDbResourceId('CreateDBInstance', { dBInstanceIdentifier: 'my-rds-instance', engine: 'postgres', dBInstanceClass: 'db.r6g.large' })).toBeNull();
        });

        it('drops a call with no engine at all', () => {
            expect(docDbResourceId('CreateDBInstance', { dBInstanceIdentifier: 'my-instance' })).toBeNull();
        });

        it('keeps the call even without a resolvable instance class in the detail', () => {
            const result = docDbResourceId('CreateDBInstance', { dBInstanceIdentifier: 'my-docdb-replica', engine: 'docdb' });
            expect(result).toEqual({ resourceId: 'my-docdb-replica', detail: undefined });
        });
    });

    describe('DeleteDBInstance', () => {
        it('keeps any call naming an instance — the engine cross-check happens in the caller via DescribeDBInstances', () => {
            expect(docDbResourceId('DeleteDBInstance', { dBInstanceIdentifier: 'my-docdb-instance' })).toEqual({ resourceId: 'my-docdb-instance' });
        });

        it('drops a call missing the instance identifier', () => {
            expect(docDbResourceId('DeleteDBInstance', {})).toBeNull();
        });
    });

    it('drops any event name outside the watched set', () => {
        expect(docDbResourceId('RebootDBInstance', { dBInstanceIdentifier: 'my-docdb-instance' })).toBeNull();
    });

    it('drops when requestParameters is entirely absent', () => {
        expect(docDbResourceId('ModifyDBInstance', undefined)).toBeNull();
    });
});
