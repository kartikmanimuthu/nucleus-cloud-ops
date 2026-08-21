// workers/src/jobs/scaling-audit/services/cloudtrail-retry.ts
//
// CloudTrail's LookupEvents throttles more eagerly than most AWS APIs, and
// under its own name: the error message is the literal string "Rate
// exceeded" — not one of the standard throttling markers ("Throttl...",
// "TooManyRequestsException", HTTP 429) the AWS SDK's built-in retry
// classifier looks for. So the SDK never recognizes it as retryable and
// never retries on its own; the very first throttled call surfaces straight
// to our catch block. Confirmed in prod: scanning 4 accounts back-to-back,
// each issuing several LookupEvents calls per scope (one per watched event
// name, per page), is enough to hit an account's LookupEvents quota — this
// will only get worse as more accounts get onboarded.
//
// One shared retry wrapper rather than duplicating a retry loop in each of
// the 5 CloudTrail-backed scope fetchers (ecs/asg, rds, docdb, msk,
// elasticache) that all make this same kind of call.

const RATE_EXCEEDED_MARKERS = ['Rate exceeded', 'Throttl', 'TooManyRequestsException'];

function isCloudTrailThrottle(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return RATE_EXCEEDED_MARKERS.some((marker) => message.includes(marker));
}

export interface CloudTrailRetryOptions {
    /** Retries AFTER the first attempt — 3 retries means 4 attempts total. */
    maxRetries?: number;
    baseDelayMs?: number;
}

/**
 * Exponential backoff with full jitter, retrying ONLY on CloudTrail's own
 * throttling signature — any other error (AccessDenied, a real service
 * outage, etc.) rethrows on the first attempt rather than being masked
 * behind a multi-second retry loop.
 *
 * ponytail: 3 retries / 500ms base is a healthy middle ground (worst case
 * ~500+1000+2000ms ≈ 3.5s of added delay before giving up), not tuned
 * against a measured quota — if throttling still surfaces regularly with
 * this in place, the fix is a higher maxRetries here, not a bigger diff.
 */
export async function withCloudTrailRetry<T>(fn: () => Promise<T>, options: CloudTrailRetryOptions = {}): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 500;

    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt >= maxRetries || !isCloudTrailThrottle(err)) throw err;
            const delayMs = Math.random() * (baseDelayMs * 2 ** attempt);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}
