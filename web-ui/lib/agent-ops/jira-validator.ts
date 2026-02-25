/**
 * Jira Webhook Validator
 * 
 * Validates Jira automation rule webhook requests.
 */

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
    // Comment added to an issue (webhookEvent: 'comment_created')
    comment?: {
        id: string;
        body?: string | {
            content?: Array<{ content?: Array<{ text?: string }> }>;
        };
        author?: {
            displayName: string;
            accountId: string;
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
 * Extract plain text from a Jira comment body (supports ADF and plain string formats).
 */
export function extractJiraCommentText(comment: JiraWebhookPayload['comment']): string {
    if (!comment?.body) return '';
    if (typeof comment.body === 'string') return comment.body.trim();

    // Atlassian Document Format (ADF) — extract text nodes recursively
    const texts: string[] = [];
    const walk = (nodes: Array<{ text?: string; content?: any[] }> = []) => {
        for (const node of nodes) {
            if (node.text) texts.push(node.text);
            if (node.content) walk(node.content);
        }
    };
    walk(comment.body.content || []);
    return texts.join('').trim();
}

/**
 * Verify the Jira webhook shared secret.
 * Jira Automation rules can include a custom header for authentication.
 *
 * @param authHeader - Authorization header value from the request
 * @param webhookSecretOverride - Webhook secret from DynamoDB; falls back to JIRA_WEBHOOK_SECRET env var
 */
export function verifyJiraSecret(authHeader: string | null, webhookSecretOverride?: string): boolean {
    const expectedSecret = webhookSecretOverride || process.env.JIRA_WEBHOOK_SECRET || '';
    if (!expectedSecret) {
        console.error('[JiraValidator] Webhook secret not configured (no DynamoDB value or JIRA_WEBHOOK_SECRET env var)');
        return false;
    }

    if (!authHeader) {
        return false;
    }

    // Support "Bearer <secret>" or raw secret
    const secret = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;

    return secret === expectedSecret;
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
