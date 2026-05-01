import { describe, it, expect } from 'vitest';
import { parseCertificatePem, computeExpiryStatus } from '@/lib/certificate-utils';

const SAMPLE_CERT = `-----BEGIN CERTIFICATE-----
MIIDazCCAlOgAwIBAgIUSJwAAABBVpTOaP2xFqAAAAAElhgwDQYJKoZIhvcNAQEL
BQAwRTELMAkGA1UEBhMCQVUxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoM
GEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0yNTA1MDEwMDAwMDBaFw0yNjA1
MDEwMDAwMDBaMEUxCzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEw
HwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDOyUT8UKfVw2KDMxJqFOqB5JqVCqJqV0qJqVCqJqVC
qJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
AwEAAaNTMFEwHQYDVR0OBBYEFOxXJqVCqJqVMFEwHQYDVR0OBBYEFAkGA1UEBhMC
QVUxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoMGEludGVybmV0IFdpZGdp
dHMgUHR5IEx0ZDAeFw0yNTA1MDEwMDAwMDBaFw0yNjA1MDEwMDAwMDBaMA0GCSqG
SIb3DQEBCwUAA4IBAQDOyUT8UKfVw2KDMxJqFOqB5JqVCqJqV0qJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
-----END CERTIFICATE-----`;

describe('parseCertificatePem', () => {
    it('validates PEM format — rejects empty string', () => {
        expect(() => parseCertificatePem('')).toThrow('Certificate body must not be empty');
    });

    it('validates PEM format — rejects non-PEM content', () => {
        expect(() => parseCertificatePem('not a certificate')).toThrow('Invalid PEM format');
    });

    it('validates PEM format — accepts valid PEM', () => {
        expect(() => parseCertificatePem(SAMPLE_CERT)).not.toThrow();
    });
});

describe('computeExpiryStatus', () => {
    it('returns expired for past dates', () => {
        const past = new Date(Date.now() - 86400000).toISOString();
        expect(computeExpiryStatus(past)).toBe('expired');
    });

    it('returns expiring for dates within 60 days', () => {
        const in30Days = new Date(Date.now() + 30 * 86400000).toISOString();
        expect(computeExpiryStatus(in30Days)).toBe('expiring');
    });

    it('returns active for dates beyond 60 days', () => {
        const in90Days = new Date(Date.now() + 90 * 86400000).toISOString();
        expect(computeExpiryStatus(in90Days)).toBe('active');
    });
});
