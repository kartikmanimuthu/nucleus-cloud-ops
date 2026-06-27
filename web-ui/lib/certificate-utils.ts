export function parseCertificatePem(body: string): void {
    if (!body || body.trim().length === 0) {
        throw new Error('Certificate body must not be empty');
    }
    const trimmed = body.trim();
    if (
        !trimmed.includes('-----BEGIN CERTIFICATE-----') ||
        !trimmed.includes('-----END CERTIFICATE-----')
    ) {
        throw new Error('Invalid PEM format: missing BEGIN/END CERTIFICATE markers');
    }
}

export function computeExpiryStatus(notAfter: string): 'active' | 'expiring' | 'expired' {
    const expiryDate = new Date(notAfter);
    const now = Date.now();
    const daysLeft = Math.ceil((expiryDate.getTime() - now) / 86400000);
    if (daysLeft < 0) return 'expired';
    if (daysLeft <= 60) return 'expiring';
    return 'active';
}

export function maskDomain(domain: string): string {
    const parts = domain.split('.');
    if (parts.length <= 1) return '***';
    return '***.' + parts.slice(1).join('.');
}

export function daysUntilExpiry(notAfter: string): number {
    return Math.ceil((new Date(notAfter).getTime() - Date.now()) / 86400000);
}

export function getExpiryColor(daysLeft: number): string {
    if (daysLeft < 0) return 'text-red-600';
    if (daysLeft <= 30) return 'text-red-500';
    if (daysLeft <= 60) return 'text-yellow-500';
    return 'text-muted-foreground';
}

/**
 * True if a wildcard `pattern` (e.g. "*.example.com") covers `host`.
 * Requires the same label count, so "*.example.com" covers "a.example.com"
 * but not "example.com" or "a.b.example.com".
 */
export function wildcardCovers(pattern: string, host: string): boolean {
    const p = pattern.trim().toLowerCase();
    const h = host.trim().toLowerCase();
    if (!p.startsWith('*.')) return false;
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.split('.').length === p.split('.').length;
}

/**
 * Domain matching used to correlate a managed certificate with an ACM certificate.
 * Pure string logic (case-insensitive), supporting exact and wildcard matches in
 * either direction. `managedDomain` is the Certificate.domainName; `acmDomain` +
 * `acmSans` come from ACM DescribeCertificate (DomainName + SubjectAlternativeNames).
 */
export function domainMatches(
    managedDomain: string,
    acmDomain: string,
    acmSans: string[] = []
): boolean {
    if (!managedDomain || !acmDomain) return false;
    const managed = managedDomain.trim().toLowerCase();
    const candidates = [acmDomain, ...acmSans]
        .filter(Boolean)
        .map(s => s.trim().toLowerCase());
    if (candidates.includes(managed)) return true;
    return candidates.some(c => wildcardCovers(managed, c) || wildcardCovers(c, managed));
}
