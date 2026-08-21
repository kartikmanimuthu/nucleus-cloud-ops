// workers/src/jobs/spot-guard/consumer.ts
//
// SQS → pg-boss ingestion bridge for Spot Guard (SG-006).
//
// WHY THIS IS NOT A pg-boss JOB
// A pg-boss cron fires discrete jobs; a handler that blocked on a 20-second
// ReceiveMessage long poll would hold a work() slot for its whole duration and get
// killed by expireInSeconds. So this is a module-owned loop, mirroring the existing
// non-pg-boss interval sweeper in jobs/agent-ops-scheduler/index.ts
// (startAgentOpsSweeper / stopAgentOpsSweeper, stopped FIRST in the index.ts shutdown
// so it cannot enqueue against a stopping boss).
//
// One necessary difference from that precedent: stopSpotGuardConsumer is ASYNC and
// aborts the in-flight poll. The loop can be parked for up to 20s inside
// ReceiveMessage, and burning 20s of the 120s ECS stopTimeout on every deploy would
// eat a sixth of the drain budget for nothing.
//
// The loop is deliberately thin — receive, enqueue, delete. All real work happens in
// the pg-boss handler, so it inherits retries, the dead-letter queue, and visibility
// in /workflows rather than being invisible inside a bespoke loop.
import type PgBoss from 'pg-boss';
import {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageBatchCommand,
    type Message,
} from '@aws-sdk/client-sqs';
import { createLogger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { SPOT_GUARD_CONFIG } from './config.js';
import type { EcsEventEnvelope, SpotGuardEventJob } from './types.js';

const log = createLogger('spot-guard-consumer');

/** Queue the ingested events are handed to. Kept here to avoid an import cycle. */
export const SPOT_GUARD_EVENT_QUEUE = 'spot-guard-event';

const ERROR_BACKOFF_START_MS = 1_000;
const ERROR_BACKOFF_MAX_MS = 30_000;

let running = false;
let stopping = false;
let loopDone: Promise<void> | null = null;
let inflight: AbortController | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A stable identity for an ECS event, used as the pg-boss singletonKey to collapse
 * SQS at-least-once duplicates cheaply.
 *
 * Content-derived rather than taken from envelope.id on purpose: a forwarded event is
 * re-emitted onto the hub bus, so its id is not a stable end-to-end key across the
 * spoke→hub hop. Task ARN + status + the relevant timestamp identifies the same
 * logical transition regardless of how many times it is delivered.
 *
 * This is an optimisation, NOT the correctness mechanism: pg-boss singletonKey only
 * dedups against created/active jobs, never completed ones, so the handler must be
 * idempotent on its own. It is (see handlers + the unique index on
 * spot_guard_events).
 */
export function eventIdentity(envelope: EcsEventEnvelope): string {
    const d = envelope.detail ?? {};
    const parts = [
        envelope['detail-type'] ?? 'unknown',
        envelope.account ?? 'unknown',
        d.taskArn ?? d.clusterArn ?? 'no-arn',
        d.lastStatus ?? d.eventName ?? 'no-status',
        d.stoppedAt ?? d.startedAt ?? d.createdAt ?? envelope.time ?? 'no-time',
    ];
    return parts.join('|').slice(0, 200);
}

export function startSpotGuardConsumer(boss: PgBoss): void {
    const queueUrl = env.SPOT_GUARD_QUEUE_URL;
    if (!queueUrl) {
        // Expected on any stack that has not opted in — not an error.
        log.info('SPOT_GUARD_QUEUE_URL unset — SQS consumer disabled');
        return;
    }
    if (running) {
        log.warn('SQS consumer already running — ignoring duplicate start');
        return;
    }
    running = true;
    stopping = false;
    loopDone = loop(boss, queueUrl, new SQSClient({}));
    log.info('SQS consumer started', {
        waitSeconds: SPOT_GUARD_CONFIG.pollWaitSeconds,
        batchSize: SPOT_GUARD_CONFIG.pollBatchSize,
    });
}

async function loop(boss: PgBoss, queueUrl: string, sqs: SQSClient): Promise<void> {
    const waitSeconds = Number(env.SPOT_GUARD_POLL_WAIT_SECONDS ?? SPOT_GUARD_CONFIG.pollWaitSeconds);
    const batchSize = Number(env.SPOT_GUARD_POLL_BATCH_SIZE ?? SPOT_GUARD_CONFIG.pollBatchSize);
    let backoff = ERROR_BACKOFF_START_MS;

    while (!stopping) {
        try {
            inflight = new AbortController();
            const res = await sqs.send(
                new ReceiveMessageCommand({
                    QueueUrl: queueUrl,
                    MaxNumberOfMessages: batchSize,
                    WaitTimeSeconds: waitSeconds,
                }),
                { abortSignal: inflight.signal },
            );
            inflight = null;
            backoff = ERROR_BACKOFF_START_MS;

            const messages = res.Messages ?? [];
            // Long polling already supplied the pacing — no sleep needed on an empty
            // receive, and adding one would only delay the next interruption.
            if (messages.length === 0) continue;

            const deletable = await enqueueBatch(boss, messages);
            if (deletable.length > 0) {
                await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: queueUrl, Entries: deletable }));
            }
        } catch (err) {
            inflight = null;
            // An abort during shutdown is expected, not an error worth logging loudly.
            if (stopping) break;
            log.error('SQS poll iteration failed', {
                error: err instanceof Error ? err.message : String(err),
                backoffMs: backoff,
            });
            await sleep(backoff);
            backoff = Math.min(backoff * 2, ERROR_BACKOFF_MAX_MS);
        }
    }

    running = false;
    log.info('SQS consumer loop exited');
}

/**
 * Enqueue each message as its own pg-boss job, returning ONLY the messages that were
 * successfully enqueued so the caller deletes exactly those.
 *
 * The critical rule: on enqueue failure we do NOT delete. The message becomes visible
 * again after the queue's 60s visibility timeout, is retried up to maxReceiveCount (5),
 * and then lands on the DLQ. Deleting a message we failed to hand off would lose the
 * event permanently and silently — the worst possible outcome for an interruption
 * warning.
 */
async function enqueueBatch(boss: PgBoss, messages: Message[]): Promise<{ Id: string; ReceiptHandle: string }[]> {
    const deletable: { Id: string; ReceiptHandle: string }[] = [];
    const ingestedAtMs = Date.now();

    for (const [i, m] of messages.entries()) {
        // Do not hand new work to a boss that is stopping; leave the message for the
        // surviving replica to pick up after the visibility timeout.
        if (stopping) break;
        if (!m.Body || !m.ReceiptHandle) {
            log.warn('SQS message missing body or receipt handle — skipping', { messageId: m.MessageId });
            continue;
        }

        try {
            const envelope = JSON.parse(m.Body) as EcsEventEnvelope;
            const payload: SpotGuardEventJob = { envelope, ingestedAtMs };

            await boss.send(SPOT_GUARD_EVENT_QUEUE, payload as unknown as object, {
                singletonKey: eventIdentity(envelope),
                singletonSeconds: 60,
                retryLimit: 3,
                retryDelay: 15,
                retryBackoff: true,
                expireInSeconds: 120,
            });
            deletable.push({ Id: String(i), ReceiptHandle: m.ReceiptHandle });
        } catch (err) {
            // Covers both malformed JSON and a failed enqueue. Either way: do not
            // delete. A permanently malformed message drains to the DLQ after 5
            // receives, which is where a human should see it.
            log.error('Failed to enqueue SQS message — left for redelivery', {
                messageId: m.MessageId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return deletable;
}

/**
 * Stop polling.
 *
 * MUST be called at the START of shutdown, BEFORE boss.stop(), so nothing is enqueued
 * against a stopping boss. Aborts the in-flight long poll so this returns in
 * milliseconds instead of waiting out WaitTimeSeconds, and resolves only once the loop
 * has actually exited.
 *
 * Anything received but not yet enqueued is simply not deleted, so it reappears on the
 * surviving replica after the visibility timeout. Nothing is lost by stopping abruptly.
 */
export async function stopSpotGuardConsumer(): Promise<void> {
    if (!running && !loopDone) return;
    stopping = true;
    inflight?.abort();
    if (loopDone) {
        await loopDone.catch(() => {
            /* loop logs its own errors; shutdown must not throw */
        });
        loopDone = null;
    }
}
