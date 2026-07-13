/**
 * Guards the web-ui production runtime contract.
 *
 * The runner stage MUST be Node, not Bun. Two production outages came from the
 * runner being `oven/bun:1-slim`:
 *
 *   1. stdio MCP servers launch via `npx -y <pkg>` and are Node packages with a
 *      `#!/usr/bin/env node` shebang. The Bun image ships no node/npm/npx, so
 *      every stdio MCP server died at pre-flight with "Command \"npx\" not found
 *      on PATH" — Slack + Atlassian tools vanished from the agent's tool belt.
 *   2. Bun does not implement `node:v8` (`isBuildingSnapshot is not yet
 *      implemented in Bun`), which the MongoDB LangGraph checkpointer reaches on
 *      /api/deep-agent/approve — an unhandledRejection that killed the route.
 *
 * A revert to Bun would silently reintroduce both, so it fails here instead.
 * (Bun in the *dependency install* and *build* stages is fine and expected.)
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const webUiRoot = path.resolve(__dirname, '../..');
const dockerfile = fs.readFileSync(path.join(webUiRoot, 'Dockerfile'), 'utf8');
const entrypoint = fs.readFileSync(path.join(webUiRoot, 'docker-entrypoint.sh'), 'utf8');

/** The `FROM … AS runner` line — the base image the container actually runs on. */
const runnerFrom = dockerfile
    .split('\n')
    .find(line => /^\s*FROM\s.+\sAS\s+runner\s*$/i.test(line))
    ?.trim();

describe('web-ui Dockerfile — production runner', () => {
    it('declares a runner stage', () => {
        expect(runnerFrom).toBeDefined();
    });

    it('runs on a Node base image, never Bun', () => {
        expect(runnerFrom).toMatch(/FROM\s+node:/i);
        expect(runnerFrom).not.toMatch(/bun/i);
    });

    it('runs as the non-root `node` user with a writable HOME for npx/uvx caches', () => {
        expect(dockerfile).toMatch(/^\s*USER\s+node\s*$/m);
        expect(dockerfile).toMatch(/HOME=\/home\/node/);
        expect(dockerfile).toMatch(/NPM_CONFIG_CACHE=/);
        expect(dockerfile).toMatch(/UV_CACHE_DIR=/);
        expect(dockerfile).toMatch(/chown -R node:node[^\n]*\/home\/node/);
    });

    it('still installs uv/uvx for Python-based MCP servers', () => {
        expect(dockerfile).toMatch(/uvx/);
    });
});

describe('web-ui docker-entrypoint.sh', () => {
    it('starts the Next.js standalone server with node, not bun', () => {
        expect(entrypoint).toMatch(/exec\s+node\s+server\.js/);
        expect(entrypoint).not.toMatch(/\bbun\b/);
    });

    it('runs prisma migrate deploy without bunx', () => {
        expect(entrypoint).toMatch(/npx[^\n]*prisma@5 migrate deploy/);
        expect(entrypoint).not.toMatch(/bunx/);
    });
});
