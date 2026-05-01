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
