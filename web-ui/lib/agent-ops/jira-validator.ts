/**
 * Jira Webhook Validator
 * 
 * Validates Jira automation rule webhook requests.
 */

const JIRA_WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET || '';

export interface JiraWebhookPayload {
    webhookEvent?: string;
    issue?: {
        key: string;
        fields?: {
            summary: string;
            description?: string;
            project?: {
                key: string;
            };
            issuetype?: {
                name: string;
            };
            reporter?: {
                displayName: string;
                emailAddress: string;
            };
        };
    };
    // Automation rule specific
    automation?: {
        ruleId: string;
        ruleName: string;
    };
    // Custom fields from automation rule
    taskDescription?: string;
    accountId?: string;
    selectedSkill?: string;
    mode?: string;
}

/**
 * Verify the Jira webhook shared secret.
 * Jira Automation rules can include a custom header for authentication.
 */
export function verifyJiraSecret(authHeader: string | null): boolean {
    if (!JIRA_WEBHOOK_SECRET) {
        console.error('[JiraValidator] JIRA_WEBHOOK_SECRET not configured');
        return false;
    }

    if (!authHeader) {
        return false;
    }

    // Support "Bearer <secret>" or raw secret
    const secret = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;

    return secret === JIRA_WEBHOOK_SECRET;
}

/**
 * Extract task description from Jira webhook payload.
 * Supports both direct taskDescription field and issue summary/description.
 */
export function extractJiraTaskDescription(payload: JiraWebhookPayload): string {
    // Direct task description from automation rule
    if (payload.taskDescription) {
        return payload.taskDescription;
    }

    // Fall back to issue summary + description
    const summary = payload.issue?.fields?.summary || '';
    const description = payload.issue?.fields?.description || '';

    if (summary && description) {
        return `${summary}\n\n${description}`;
    }

    return summary || description || 'No task description provided';
}
