import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * AWS Session Profile Manager
 *
 * Manages temporary AWS profiles for agent sessions.
 * Profile naming convention: nucleus_agent_<accountId>_<timestamp>
 *
 * SECURITY — per-tenant credential file isolation:
 * Each tenant's temporary STS credentials are written to a dedicated credentials
 * file under a private root (`<tmpdir>/nucleus-aws-creds/<tenantId>/credentials`)
 * that lives OUTSIDE the agent file-tool jail (see AGENT_WORKDIR in tools.ts).
 * The file-tools cannot resolve a path into this root, so one tenant's agent can
 * no longer read another tenant's live session credentials via read_file/ls/grep.
 * Callers point the AWS CLI/SDK at the right file via AWS_SHARED_CREDENTIALS_FILE.
 *
 * A caller that does not pass a tenantId falls back to the legacy shared
 * `~/.aws/credentials` file (preserved for non-tenant-scoped local usage).
 *
 * Features:
 * - Creates profiles per AWS account, isolated per tenant
 * - Cleans up all agent credentials on server restart
 */

export interface SessionProfile {
    profileName: string;
    accountId: string;
    region: string;
    createdAt: Date;
    expiresAt: Date;
    /** Absolute path to the credentials file this profile was written to. */
    credentialsFile: string;
}

export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    region: string;
}

// Legacy shared AWS credentials file (used only when no tenantId is supplied).
const LEGACY_AWS_CREDENTIALS_FILE = path.join(os.homedir(), '.aws', 'credentials');

// Private root for per-tenant credential files. Deliberately a SIBLING of the
// agent file-tool jail (AGENT_WORKDIR, default <tmpdir>/nucleus-agent) so file
// tools cannot resolve a path into it.
const TENANT_CREDS_ROOT = path.join(os.tmpdir(), 'nucleus-aws-creds');

// Profile name prefix for identification during cleanup
const PROFILE_PREFIX = 'nucleus_agent_';

/**
 * Resolve the absolute credentials-file path for a tenant.
 * Deterministic so execute_command (which only has the tenantId) can point
 * AWS_SHARED_CREDENTIALS_FILE at the same file this module writes to.
 */
export function getTenantCredentialsFilePath(tenantId: string): string {
    const sanitized = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
    return path.join(TENANT_CREDS_ROOT, sanitized, 'credentials');
}

/**
 * Generate a unique profile name
 */
function generateProfileName(accountId: string): string {
    const timestamp = Date.now();
    return `${PROFILE_PREFIX}${accountId}_${timestamp}`;
}

/**
 * Read the current AWS credentials file
 */
async function readCredentialsFile(filePath: string): Promise<string> {
    try {
        return await fs.readFile(filePath, 'utf-8');
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return '';
        }
        throw error;
    }
}

/**
 * Write to the AWS credentials file
 */
async function writeCredentialsFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, { mode: 0o600 });
}

/**
 * Parse credentials file into sections
 */
function parseCredentialsFile(content: string): Map<string, Map<string, string>> {
    const profiles = new Map<string, Map<string, string>>();
    let currentProfile = '';

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        const profileMatch = trimmed.match(/^\[(.+)\]$/);
        if (profileMatch) {
            currentProfile = profileMatch[1];
            profiles.set(currentProfile, new Map());
            continue;
        }
        const kvMatch = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
        if (kvMatch && currentProfile) {
            profiles.get(currentProfile)?.set(kvMatch[1].trim(), kvMatch[2].trim());
        }
    }
    return profiles;
}

/**
 * Serialize profiles back to credentials file format
 */
function serializeCredentialsFile(profiles: Map<string, Map<string, string>>): string {
    const lines: string[] = [];
    for (const [profileName, credentials] of profiles) {
        lines.push(`[${profileName}]`);
        for (const [key, value] of credentials) {
            lines.push(`${key} = ${value}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

/**
 * Create a new AWS session profile.
 *
 * When tenantId is provided the profile is written to that tenant's isolated
 * credentials file; otherwise it falls back to the legacy shared file.
 */
export async function createSessionProfile(
    accountId: string,
    credentials: AwsCredentials,
    tenantId?: string
): Promise<SessionProfile> {
    console.log(`[SessionManager] Creating profile for account: ${accountId}${tenantId ? ` (tenant: ${tenantId})` : ''}`);

    const profileName = generateProfileName(accountId);
    const credentialsFile = tenantId ? getTenantCredentialsFilePath(tenantId) : LEGACY_AWS_CREDENTIALS_FILE;

    const profile: SessionProfile = {
        profileName,
        accountId,
        region: credentials.region,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
        credentialsFile,
    };

    // Read current credentials file
    const content = await readCredentialsFile(credentialsFile);
    const profiles = parseCredentialsFile(content);

    // Add new profile
    const profileCreds = new Map<string, string>();
    profileCreds.set('aws_access_key_id', credentials.accessKeyId);
    profileCreds.set('aws_secret_access_key', credentials.secretAccessKey);
    profileCreds.set('aws_session_token', credentials.sessionToken);
    profileCreds.set('region', credentials.region);
    profiles.set(profileName, profileCreds);

    // Write back to file
    await writeCredentialsFile(credentialsFile, serializeCredentialsFile(profiles));

    console.log(`[SessionManager] Created profile: ${profileName} in ${credentialsFile}`);

    return profile;
}

/**
 * Remove a single tenant's credentials file (called on run end / credential rotation).
 */
export async function cleanupTenantCredentials(tenantId: string): Promise<void> {
    const filePath = getTenantCredentialsFilePath(tenantId);
    try {
        await fs.rm(path.dirname(filePath), { recursive: true, force: true });
        console.log(`[SessionManager] Removed credentials for tenant ${tenantId}`);
    } catch (error) {
        console.error(`[SessionManager] Error removing tenant ${tenantId} credentials:`, error);
    }
}

/**
 * Cleanup all agent profiles (called on server startup).
 * Removes the entire per-tenant credentials root AND strips agent profiles
 * from the legacy shared file.
 */
export async function cleanupAllAgentProfiles(): Promise<void> {
    console.log('[SessionManager] Cleaning up all agent profiles...');

    // 1. Nuke the per-tenant credentials root wholesale.
    try {
        await fs.rm(TENANT_CREDS_ROOT, { recursive: true, force: true });
    } catch (error) {
        console.error('[SessionManager] Error removing per-tenant credentials root:', error);
    }

    // 2. Strip agent-created profiles from the legacy shared file (leave any
    //    user/SSO profiles untouched).
    try {
        const content = await readCredentialsFile(LEGACY_AWS_CREDENTIALS_FILE);
        const profiles = parseCredentialsFile(content);

        let removedCount = 0;
        for (const profileName of profiles.keys()) {
            if (profileName.startsWith(PROFILE_PREFIX)) {
                profiles.delete(profileName);
                removedCount++;
            }
        }

        if (removedCount > 0) {
            await writeCredentialsFile(LEGACY_AWS_CREDENTIALS_FILE, serializeCredentialsFile(profiles));
            console.log(`[SessionManager] Removed ${removedCount} stale agent profiles from legacy file`);
        } else {
            console.log('[SessionManager] No stale agent profiles found in legacy file');
        }
    } catch (error) {
        console.error('[SessionManager] Error during cleanup:', error);
    }
}

// Run cleanup on module load (server startup)
cleanupAllAgentProfiles().catch(console.error);
