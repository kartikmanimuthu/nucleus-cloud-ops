/**
 * Secret redaction for sub-agent transcripts, applied at the persistence boundary.
 *
 * Why this exists: the `aws_read` allowlist permits `lambda
 * get-function-configuration`, which returns `Environment.Variables` in PLAINTEXT —
 * DB passwords, API keys, Stripe secrets (see the NOTE in aws-read-tool.ts). A
 * sub-agent transcript is persisted for 30 days in a multi-tenant database that also
 * backs chat history, so those values must never reach at-rest storage. The sub-agent
 * still sees the value live in its own reasoning; that is accepted and out of scope.
 *
 * Two complementary strategies:
 *   - by LOCATION — everything under an `Environment.Variables` object is redacted,
 *     because an arbitrary env var name tells us nothing about its sensitivity;
 *   - by KEY NAME — a secret-shaped key is redacted wherever it appears.
 *
 * Only the VALUE is replaced. Keys are always preserved: an operator expanding a card
 * needs to see that `DB_PASSWORD` exists.
 *
 * Pure, synchronous, no I/O, no imports from the agent runtime — and total. It runs
 * inside a database write, so throwing would fail the persistence it exists to protect.
 */

export const REDACTED = '[REDACTED]';

/** Depth ceiling. Beyond it we fail closed rather than emit an unwalked subtree. */
const MAX_DEPTH = 64;

/** Case-insensitive substring match against a key name. */
const SECRET_KEY_PATTERNS = [
    'password',
    'passwd',
    'secret',
    'token',
    'apikey',
    'api_key',
    'api-key',
    'credential',
    'privatekey',
    'private_key',
    'sessiontoken',
];

function isSecretKey(key: string): boolean {
    const lower = key.toLowerCase();
    return SECRET_KEY_PATTERNS.some(pattern => lower.includes(pattern));
}

/** Alternation used by the non-JSON fallback. Ordered longest-first so `api_key` wins over `key`. */
const SECRET_KEY_ALTERNATION = '[A-Za-z0-9_.\\-]*(?:password|passwd|secret|token|api[_-]?key|credential|private[_-]?key)[A-Za-z0-9_.\\-]*';

/**
 * Credentials embedded in a URL: `scheme://user:password@host` → the password is
 * replaced, the user and host kept. No key name is involved, so neither the key-name
 * nor the location rule can see these — and an `OutputValue` holding a connection
 * string is a realistic `describe-stacks` response.
 *
 * The userinfo segment forbids `/` so a path containing `@` (an S3 key, an ARN) can
 * never be mistaken for credentials, and it requires a `:` so `ssh://git@github.com`
 * is left alone.
 */
const URL_CREDENTIAL_RE = /\b([A-Za-z][A-Za-z0-9+.\-]*:\/\/)([^\s:/@]*):([^\s/@]+)@/g;

function redactUrlCredentials(text: string): string {
    return text.replace(URL_CREDENTIAL_RE, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`);
}

/**
 * Sibling name/value pairs: `{ParameterKey: 'DBPassword', ParameterValue: 'hunter2'}`.
 *
 * The secret sits under a key that is NOT secret-shaped (`ParameterValue`); what names
 * it is a *sibling* field. Key-name matching is structurally blind to this, and it is
 * the shape `cloudformation describe-stacks` returns — the exact call an audit
 * sub-agent makes. The same shape covers container env definitions
 * (`{name, value}`) and bare `{Key, Value}` tags.
 *
 * Only the value is redacted, never the name, so an operator still sees WHICH
 * parameter was withheld.
 *
 * @returns the field names in this object whose values must be redacted.
 */
function siblingSecretFields(obj: Record<string, unknown>): Set<string> {
    const redact = new Set<string>();
    const byLower = new Map<string, string>();
    for (const key of Object.keys(obj)) byLower.set(key.toLowerCase(), key);

    for (const [lower, actual] of byLower) {
        const name = obj[actual];
        // The NAME must itself be a string, and it is the string we test for
        // secret-ness — not the key it is stored under.
        if (typeof name !== 'string' || !isSecretKey(name)) continue;

        for (const suffix of ['key', 'name']) {
            if (!lower.endsWith(suffix)) continue;
            // `ParameterKey` pairs with `ParameterValue`; `Key` with `Value`.
            const partner = byLower.get(`${lower.slice(0, -suffix.length)}value`);
            if (partner !== undefined && partner !== actual) redact.add(partner);
        }
    }
    return redact;
}

/**
 * Redact a parsed JSON value in place-free fashion.
 *
 * @param redactAll true when the caller is already inside an `Environment.Variables`
 *                  object, where every value is redacted regardless of its key.
 */
function redactValue(value: unknown, depth: number, seen: WeakSet<object>, redactAll: boolean): unknown {
    if (depth > MAX_DEPTH) return REDACTED;
    if (value === null || typeof value !== 'object') {
        if (redactAll) return REDACTED;
        // A credential can hide inside an otherwise innocuous string value.
        return typeof value === 'string' ? redactUrlCredentials(value) : value;
    }

    const asObject = value as object;
    // A cycle can only come from a caller handing us a live object graph (parsed JSON
    // is always acyclic). Break it rather than recursing forever.
    if (seen.has(asObject)) return '[CYCLE]';
    seen.add(asObject);

    if (Array.isArray(value)) {
        return value.map(item => redactValue(item, depth + 1, seen, redactAll));
    }

    const record = value as Record<string, unknown>;
    const siblingSecrets = redactAll ? null : siblingSecretFields(record);

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
        if (redactAll || isSecretKey(key) || siblingSecrets?.has(key)) {
            // Redact the whole subtree: a secret-named key may hold an object.
            out[key] = redactValue(child, depth + 1, seen, true);
            continue;
        }
        // Redact by LOCATION: everything under `Environment: { Variables: {...} }`.
        // Keyed on `Variables` alone rather than the full path — an object named
        // `Variables` in an AWS response is env vars whatever its parent, and erring
        // wide here costs an operator nothing but erring narrow leaks a secret.
        out[key] = redactValue(child, depth + 1, seen, /^variables$/i.test(key));
    }
    return out;
}

/**
 * Sibling name/value pairs in text the structural walk could not parse. Truncated JSON
 * is the common case, not the exotic one: a sub-agent's tool output is capped, so a
 * large `describe-stacks` response arrives here with its tail cut off.
 */
const SIBLING_PAIR_TEXT_RE =
    /("[A-Za-z0-9_.\-]*(?:Key|Name)"\s*:\s*")((?:\\.|[^"])*)("\s*,\s*"[A-Za-z0-9_.\-]*Value"\s*:\s*")(?:\\.|[^"])*(")/gi;

/** Regex scrubbing for text that is not JSON (shell commands, prose, truncated output). */
function redactPlainText(text: string): string {
    let out = text;
    // Credentials inside a URL — no key name to match on, so this must run here too.
    out = redactUrlCredentials(out);
    // {"ParameterKey":"DBPassword","ParameterValue":"…"} — the name is a sibling field.
    out = out.replace(
        SIBLING_PAIR_TEXT_RE,
        (whole, open: string, name: string, mid: string, close: string) =>
            isSecretKey(name) ? `${open}${name}${mid}${REDACTED}${close}` : whole,
    );
    // "key": "value"  /  'key': 'value'
    out = out.replace(
        new RegExp(`(["']?${SECRET_KEY_ALTERNATION}["']?\\s*:\\s*)(["'])(?:\\\\.|(?!\\2).)*\\2`, 'gi'),
        (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
    );
    // key: value   (unquoted, to end of line / delimiter)
    out = out.replace(
        new RegExp(`(\\b${SECRET_KEY_ALTERNATION}\\s*:\\s*)([^\\s,;}"']+)`, 'gi'),
        (_m, prefix: string) => `${prefix}${REDACTED}`,
    );
    // KEY=value  (shell assignment)
    out = out.replace(
        new RegExp(`(\\b${SECRET_KEY_ALTERNATION}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s&;|]+)`, 'gi'),
        (_m, prefix: string) => `${prefix}${REDACTED}`,
    );
    return out;
}

/** Redact one transcript entry's `text`, preferring a structural walk over regex. */
function redactText(text: string): string {
    const trimmed = text.trim();
    const looksStructural = trimmed.startsWith('{') || trimmed.startsWith('[');

    if (looksStructural) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            return JSON.stringify(redactValue(parsed, 0, new WeakSet(), false));
        } catch {
            // Truncated or otherwise unparseable JSON — fall through to regex. Never
            // return the raw input here: that is exactly the leak path.
        }
    }
    return redactPlainText(text);
}

function isTranscriptEntry(value: unknown): value is { text: string } {
    return typeof value === 'object'
        && value !== null
        && typeof (value as { text?: unknown }).text === 'string';
}

/**
 * Redact secrets from a sub-agent transcript (or any value on its way to storage).
 *
 * `null`/`undefined` pass through unchanged. An array of transcript entries has each
 * entry's `text` scrubbed; anything else is walked structurally. Never throws — on an
 * internal error the input is replaced with a safe placeholder rather than persisted raw.
 */
export function redactTranscript<T>(transcript: T): T {
    if (transcript === null || transcript === undefined) return transcript;

    try {
        if (typeof transcript === 'string') {
            return redactText(transcript) as unknown as T;
        }

        if (Array.isArray(transcript)) {
            return transcript.map(item =>
                isTranscriptEntry(item)
                    ? { ...item, text: redactText(item.text) }
                    : redactValue(item, 0, new WeakSet(), false),
            ) as unknown as T;
        }

        if (isTranscriptEntry(transcript)) {
            return { ...transcript, text: redactText(transcript.text) } as unknown as T;
        }

        return redactValue(transcript, 0, new WeakSet(), false) as unknown as T;
    } catch (error) {
        console.error('[subagent-redact] redaction failed; storing a placeholder instead:', error);
        // Fail closed: a redactor that cannot prove the payload is clean must not
        // hand the raw payload to the database.
        return REDACTED as unknown as T;
    }
}
