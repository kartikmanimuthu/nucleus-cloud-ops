import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * AWS Session Profile Manager
 * 
 * Manages temporary AWS profiles stored in ~/.aws/credentials for agent sessions.
 * Profile naming convention: nucleus_agent_<accountId>_<timestamp>
 * 
 * Features:
 * - Creates profiles per AWS account
 * - Cleans up all agent profiles on server restart
 */

export interface SessionProfile {
    profileName: string;
    accountId: string;
    region: string;
    createdAt: Date;
    expiresAt: Date;
}

export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    region: string;
}

// AWS credentials file path
const AWS_CREDENTIALS_FILE = path.join(os.homedir(), '.aws', 'credentials');

// Profile name prefix for identification during cleanup
const PROFILE_PREFIX = 'nucleus_agent_';

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
async function readCredentialsFile(): Promise<string> {
    try {
        return await fs.readFile(AWS_CREDENTIALS_FILE, 'utf-8');
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
async function writeCredentialsFile(content: string): Promise<void> {
    const awsDir = path.dirname(AWS_CREDENTIALS_FILE);
    await fs.mkdir(awsDir, { recursive: true });
    await fs.writeFile(AWS_CREDENTIALS_FILE, content, { mode: 0o600 });
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
 * Create a new AWS session profile
 */
export async function createSessionProfile(
    accountId: string,
    credentials: AwsCredentials
): Promise<SessionProfile> {
    console.log(`[SessionManager] Creating profile for account: ${accountId}`);

    const profileName = generateProfileName(accountId);

    const profile: SessionProfile = {
        profileName,
        accountId,
        region: credentials.region,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
    };

    // Read current credentials file
    const content = await readCredentialsFile();
    const profiles = parseCredentialsFile(content);

    // Add new profile
    const profileCreds = new Map<string, string>();
    profileCreds.set('aws_access_key_id', credentials.accessKeyId);
    profileCreds.set('aws_secret_access_key', credentials.secretAccessKey);
    profileCreds.set('aws_session_token', credentials.sessionToken);
    profileCreds.set('region', credentials.region);
    profiles.set(profileName, profileCreds);

    // Write back to file
    await writeCredentialsFile(serializeCredentialsFile(profiles));

    console.log(`[SessionManager] Created profile: ${profileName}`);

    return profile;
}

/**
 * Cleanup all agent profiles (called on server startup)
 */
export async function cleanupAllAgentProfiles(): Promise<void> {
    console.log('[SessionManager] Cleaning up all agent profiles...');

    try {
        const content = await readCredentialsFile();
        const profiles = parseCredentialsFile(content);

        let removedCount = 0;
        for (const profileName of profiles.keys()) {
            if (profileName.startsWith(PROFILE_PREFIX)) {
                profiles.delete(profileName);
                removedCount++;
            }
        }

        if (removedCount > 0) {
            await writeCredentialsFile(serializeCredentialsFile(profiles));
            console.log(`[SessionManager] Removed ${removedCount} stale agent profiles`);
        } else {
            console.log('[SessionManager] No stale agent profiles found');
        }
    } catch (error) {
        console.error('[SessionManager] Error during cleanup:', error);
    }
}

// Run cleanup on module load (server startup)
cleanupAllAgentProfiles().catch(console.error);
