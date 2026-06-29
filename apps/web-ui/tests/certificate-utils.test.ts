import { describe, it, expect } from 'vitest';
import {
    parseCertificatePem,
    computeExpiryStatus,
    domainMatches,
    wildcardCovers,
} from '@/lib/certificate-utils';

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

describe('wildcardCovers', () => {
    it('covers a same-label-count subdomain', () => {
        expect(wildcardCovers('*.example.com', 'api.example.com')).toBe(true);
    });

    it('does not cover the apex or deeper subdomains', () => {
        expect(wildcardCovers('*.example.com', 'example.com')).toBe(false);
        expect(wildcardCovers('*.example.com', 'a.b.example.com')).toBe(false);
    });

    it('returns false when pattern is not a wildcard', () => {
        expect(wildcardCovers('example.com', 'example.com')).toBe(false);
    });
});

describe('domainMatches', () => {
    it('matches exact domain, case-insensitively', () => {
        expect(domainMatches('Api.Example.com', 'api.example.com')).toBe(true);
    });

    it('matches against a SAN entry', () => {
        expect(domainMatches('api.example.com', 'example.com', ['api.example.com'])).toBe(true);
    });

    it('matches a managed wildcard against a concrete ACM domain', () => {
        // The real-world bug: managed "*.smcinvesteasy.com" vs ACM "api.smcinvesteasy.com"
        expect(domainMatches('*.smcinvesteasy.com', 'api.smcinvesteasy.com')).toBe(true);
    });

    it('matches a managed concrete domain against an ACM wildcard SAN', () => {
        expect(domainMatches('api.example.com', 'other.com', ['*.example.com'])).toBe(true);
    });

    it('does not match unrelated domains', () => {
        expect(domainMatches('example.com', 'example.org')).toBe(false);
        expect(domainMatches('*.example.com', 'example.net')).toBe(false);
    });

    it('returns false on empty inputs', () => {
        expect(domainMatches('', 'example.com')).toBe(false);
        expect(domainMatches('example.com', '')).toBe(false);
    });
});
