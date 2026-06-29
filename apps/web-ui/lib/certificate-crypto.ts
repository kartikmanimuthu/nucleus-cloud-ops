/**
 * Server-only certificate material parsing + validation.
 *
 * Kept separate from `certificate-utils.ts` because this imports `node:crypto`,
 * while certificate-utils.ts is imported by client components and must stay
 * crypto-free.
 */
import { X509Certificate, createPublicKey } from 'crypto';
import { domainMatches } from '@/lib/certificate-utils';

export interface ParsedCertificate {
    notBefore: string; // ISO
    notAfter: string; // ISO
    issuer: string;
    serialNumber: string | null;
    fingerprint: string; // sha256 hex, lowercase, no separators
    domains: string[]; // subject CN + SANs (DNS)
}

/** sha256 fingerprint of the certificate, normalized to lowercase hex without colons. */
export function computeFingerprint(bodyPem: string): string {
    const x509 = new X509Certificate(bodyPem);
    return x509.fingerprint256.replace(/:/g, '').toLowerCase();
}

/** Extract the DNS names a certificate is valid for (subject CN + SAN DNS entries). */
export function extractCertDomains(x509: X509Certificate): string[] {
    const domains = new Set<string>();

    // Subject CN
    const cnMatch = x509.subject.split('\n').find(l => l.startsWith('CN='));
    if (cnMatch) domains.add(cnMatch.replace('CN=', '').trim());

    // SubjectAltName: "DNS:example.com, DNS:*.example.com, IP Address:..."
    if (x509.subjectAltName) {
        for (const entry of x509.subjectAltName.split(',')) {
            const trimmed = entry.trim();
            if (trimmed.startsWith('DNS:')) {
                domains.add(trimmed.slice(4).trim());
            }
        }
    }
    return [...domains].filter(Boolean);
}

/**
 * Parse + structurally validate a certificate body PEM. Throws on invalid PEM.
 */
export function parseCertificate(bodyPem: string): ParsedCertificate {
    const x509 = new X509Certificate(bodyPem);
    const issuer =
        x509.issuer
            .split('\n')
            .find(l => l.startsWith('O='))
            ?.replace('O=', '')
            .trim() || x509.issuer;
    return {
        notBefore: new Date(x509.validFrom).toISOString(),
        notAfter: new Date(x509.validTo).toISOString(),
        issuer,
        serialNumber: x509.serialNumber ?? null,
        fingerprint: x509.fingerprint256.replace(/:/g, '').toLowerCase(),
        domains: extractCertDomains(x509),
    };
}

/**
 * Verify the private key matches the certificate by comparing the SPKI export of
 * the cert's public key against the public key derived from the private key.
 * Throws if they do not match or either is unparseable.
 */
export function validateKeyPair(bodyPem: string, privateKeyPem: string): void {
    let certSpki: string;
    let keySpki: string;
    try {
        const x509 = new X509Certificate(bodyPem);
        certSpki = x509.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    } catch {
        throw new Error('Invalid certificate body: could not parse the public key');
    }
    try {
        const pub = createPublicKey(privateKeyPem);
        keySpki = pub.export({ type: 'spki', format: 'pem' }).toString();
    } catch {
        throw new Error('Invalid private key: could not parse PEM');
    }
    if (certSpki !== keySpki) {
        throw new Error('Private key does not match the certificate');
    }
}

/**
 * True if the certificate's CN/SAN covers the given domain (exact or wildcard).
 * Used to lock a new version to the certificate's domain.
 */
export function certificateCoversDomain(bodyPem: string, domain: string): boolean {
    const x509 = new X509Certificate(bodyPem);
    const domains = extractCertDomains(x509);
    return domains.some(d => domainMatches(domain, d) || domainMatches(d, domain));
}
