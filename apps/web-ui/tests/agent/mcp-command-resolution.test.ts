/**
 * Regression tests for stdio MCP command resolution.
 *
 * Production failure: the web-ui runner image was `oven/bun:1-slim`, which ships
 * no node/npm/npx. Every stdio MCP server (`npx -y @modelcontextprotocol/server-slack`,
 * `npx -y mcp-remote …`) failed its pre-flight check with
 *   `Command "npx" not found on PATH`
 * so Slack + Atlassian tools were simply absent from the agent's tool belt.
 *
 * The image fix (runner → node:20-slim) is enforced by dockerfile-runtime.test.ts.
 * These tests cover the lookup itself, which previously shelled out to `which`:
 * if `which` is missing from a slim base image, execFileSync throws and EVERY
 * command is reported unavailable — a silent, total MCP outage. The PATH walk
 * has no such dependency.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isCommandAvailable } from '../../lib/agent/mcp-manager';

let binDir: string;
let emptyDir: string;

beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-path-'));
    binDir = path.join(root, 'bin');
    emptyDir = path.join(root, 'empty');
    fs.mkdirSync(binDir);
    fs.mkdirSync(emptyDir);

    // An executable stand-in for `npx`.
    fs.writeFileSync(path.join(binDir, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // Present but NOT executable — must not count as available.
    fs.writeFileSync(path.join(binDir, 'not-exec'), 'nope\n', { mode: 0o644 });
    // A directory named like a command — must not count as available.
    fs.mkdirSync(path.join(binDir, 'a-directory'));
});

afterAll(() => {
    fs.rmSync(path.dirname(binDir), { recursive: true, force: true });
});



describe('isCommandAvailable', () => {
    it('finds an executable on PATH', () => {
        expect(isCommandAvailable('npx', binDir)).toBe(true);
    });

    it('finds an executable in any PATH entry, not just the first', () => {
        const p = [emptyDir, binDir].join(path.delimiter);
        expect(isCommandAvailable('npx', p)).toBe(true);
    });

    it('reports a command absent from PATH as unavailable — the production npx failure', () => {
        expect(isCommandAvailable('npx', emptyDir)).toBe(false);
    });

    it('does not depend on `which` being installed (empty PATH still resolves cleanly)', () => {
        expect(() => isCommandAvailable('npx', '')).not.toThrow();
        expect(isCommandAvailable('npx', '')).toBe(false);
    });

    it('rejects a non-executable file', () => {
        expect(isCommandAvailable('not-exec', binDir)).toBe(false);
    });

    it('rejects a directory that shares a command name', () => {
        expect(isCommandAvailable('a-directory', binDir)).toBe(false);
    });

    it('resolves an explicit path without consulting PATH', () => {
        const abs = path.join(binDir, 'npx');
        expect(isCommandAvailable(abs, emptyDir)).toBe(true);
        expect(isCommandAvailable(path.join(emptyDir, 'npx'), binDir)).toBe(false);
    });

    it('treats an empty command as unavailable', () => {
        expect(isCommandAvailable('', binDir)).toBe(false);
    });
});
