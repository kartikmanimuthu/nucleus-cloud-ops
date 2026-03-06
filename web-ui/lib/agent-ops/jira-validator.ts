/**
 * Jira Webhook Validator
 * 
 * Validates Jira automation rule webhook requests and native Jira webhooks.
 * Includes ADF mention node parsing for bot mention detection.
 */

// ─── ADF node types ────────────────────────────────────────────────────

interface AdfNode {
    type: string;
    text?: string;
    attrs?: Record<string, string>;
    content?: AdfNode[];
}

export interface JiraWebhookPayload {
    webhookEvent?: string;  // Present on native Jira webhooks (e.g. 'comment_created')
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
    // Comment added to an issue (webhookEvent: 'comment_created' or Automation rule)
    comment?: {
        id: string;
        body?: string | AdfNode;
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

// ─── ADF helpers ───────────────────────────────────────────────────────

/**
 * Walk all nodes in an ADF document and collect mention node accountIds.
 */
export function extractMentionAccountIds(body: AdfNode | string | undefined): string[] {
    if (!body || typeof body === 'string') return [];
    const ids: string[] = [];
    const walk = (nodes: AdfNode[] = []) => {
        for (const node of nodes) {
            if (node.type === 'mention' && node.attrs?.id) ids.push(node.attrs.id);
            if (node.content) walk(node.content);
        }
    };
    walk((body as AdfNode).content || []);
    return ids;
}

/**
 * Returns true if the comment body contains a mention of the configured bot account.
 */
export function isBotMention(
    comment: JiraWebhookPayload['comment'],
    botAccountId: string | undefined,
): boolean {
    if (!botAccountId || !comment?.body) return false;
    const ids = extractMentionAccountIds(comment.body as AdfNode);
    return ids.includes(botAccountId);
}

/**
 * Extract plain text from ADF, skipping mention nodes (returns task text without the @mention).
 * Falls back to full text extraction for plain string bodies.
 */
export function extractCommentTextWithoutMention(body: AdfNode | string | undefined): string {
    if (!body) return '';
    if (typeof body === 'string') return body.trim();

    const texts: string[] = [];
    const walk = (nodes: AdfNode[] = []) => {
        for (const node of nodes) {
            if (node.type === 'mention') continue; // skip mention nodes
            if (node.text) texts.push(node.text);
            if (node.content) walk(node.content);
        }
    };
    walk((body as AdfNode).content || []);
    return texts.join('').trim();
}

/**
 * Extract plain text from a Jira comment body (supports ADF and plain string formats).
 * Includes mention node text.
 */
export function extractJiraCommentText(comment: JiraWebhookPayload['comment']): string {
    if (!comment?.body) return '';
    if (typeof comment.body === 'string') return comment.body.trim();

    const texts: string[] = [];
    const walk = (nodes: AdfNode[] = []) => {
        for (const node of nodes) {
            if (node.text) texts.push(node.text);
            if (node.content) walk(node.content);
        }
    };
    walk((comment.body as AdfNode).content || []);
    return texts.join('').trim();
}

/**
 * Verify the Jira webhook shared secret.
 * Supports:
 *   - Automation rules: Authorization header (Bearer <secret> or raw secret)
 *   - Native Jira webhooks: ?secret=<value> query param
 *
 * @param authHeader - Authorization or x-webhook-secret header value
 * @param querySecret - Secret from ?secret= query param (native webhooks)
 * @param webhookSecretOverride - Webhook secret from DynamoDB; falls back to JIRA_WEBHOOK_SECRET env var
 */
export function verifyJiraSecret(
    authHeader: string | null,
    webhookSecretOverride?: string,
    querySecret?: string | null,
): boolean {
    const expectedSecret = webhookSecretOverride || process.env.JIRA_WEBHOOK_SECRET || '';
    if (!expectedSecret) {
        console.error('[JiraValidator] Webhook secret not configured (no DynamoDB value or JIRA_WEBHOOK_SECRET env var)');
        return false;
    }

    // Try Authorization / x-webhook-secret header first (Automation rules)
    if (authHeader) {
        const secret = authHeader.startsWith('Bearer ')
            ? authHeader.slice(7)
            : authHeader;
        if (secret === expectedSecret) return true;
    }

    // Fall back to ?secret= query param (native Jira webhooks)
    if (querySecret && querySecret === expectedSecret) return true;

    return false;
}

/**
 * Extract task description from Jira webhook payload.
 * Supports both direct taskDescription field and issue summary/description.
 */
export function extractJiraTaskDescription(payload: JiraWebhookPayload): string {
    if (payload.taskDescription) {
        return payload.taskDescription;
    }

    const summary = payload.issue?.fields?.summary || '';
    const description = payload.issue?.fields?.description || '';

    if (summary && description) {
        return `${summary}\n\n${description}`;
    }

    return summary || description || 'No task description provided';
}
