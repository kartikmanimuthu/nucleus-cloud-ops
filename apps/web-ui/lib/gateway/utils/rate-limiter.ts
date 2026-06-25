// web-ui/lib/gateway/utils/rate-limiter.ts
export class ChannelRateLimiter {
    private lastSent = new Map<string, number>();

    constructor(private minIntervalMs: number) {}

    shouldSend(key: string): boolean {
        const now = Date.now();
        const last = this.lastSent.get(key) ?? 0;
        if (now - last < this.minIntervalMs) return false;
        this.lastSent.set(key, now);
        return true;
    }

    reset(key: string): void {
        this.lastSent.delete(key);
    }
}
