import type { AwsCredentials } from './types';

/**
 * Build a set of AWS environment variables from credentials.
 * These are injected into the PTY process env at spawn time.
 */
export function buildAwsEnv(creds: AwsCredentials): Record<string, string> {
    return {
        AWS_ACCESS_KEY_ID: creds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
        AWS_SESSION_TOKEN: creds.sessionToken,
        AWS_DEFAULT_REGION: creds.region,
        AWS_REGION: creds.region,
    };
}

/**
 * Generate shell export commands that set AWS credentials in the PTY.
 * Useful for re-injecting refreshed credentials into a running session.
 */
export function buildExportCommands(creds: AwsCredentials): string {
    const env = buildAwsEnv(creds);
    return (
        Object.entries(env)
            .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
            .join('\n') + '\n'
    );
}

/**
 * Validate that credentials are non-empty and not yet expired.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateCredentials(creds: AwsCredentials): string | null {
    if (!creds.accessKeyId || !creds.secretAccessKey || !creds.sessionToken) {
        return 'Missing required credential fields';
    }
    if (!creds.region) {
        return 'Missing AWS region';
    }
    const expiresAt = new Date(creds.expiresAt);
    if (isNaN(expiresAt.getTime())) {
        return 'Invalid expiresAt timestamp';
    }
    if (expiresAt <= new Date()) {
        return 'Credentials have expired';
    }
    return null;
}

/**
 * Returns true if credentials expire within the given threshold (default 5 min).
 */
export function isExpiringSoon(creds: AwsCredentials, thresholdMs = 5 * 60 * 1000): boolean {
    const expiresAt = new Date(creds.expiresAt);
    return expiresAt.getTime() - Date.now() < thresholdMs;
}

/** Minimal shell escaping — wraps value in single quotes, escaping internal single quotes. */
function shellEscape(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
