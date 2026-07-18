# Multi-stage Dockerfile for Next.js Web UI on ECS Fargate
# Uses Bun for dependency installation, build, and production runtime
# Build context: project root (not apps/web-ui/) — required to include libs/prisma/

# ── Stage 1: Install dependencies with Bun ──
FROM oven/bun:1-slim AS deps
WORKDIR /app

COPY apps/web-ui/package.json apps/web-ui/bun.lock ./

# Install production dependencies only
RUN bun install --frozen-lockfile --production

# ── Stage 2: Install all deps with Bun (has the lockfile) ──
FROM oven/bun:1-slim AS deps-all
WORKDIR /app

COPY apps/web-ui/package.json apps/web-ui/bun.lock ./

RUN bun install --frozen-lockfile

# ── Stage 3: Build with Node (Bun SSR breaks pages-router 404 prerender) ──
FROM node:20-slim AS builder
WORKDIR /app

# Install openssl for Prisma engine binaries
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy node_modules from Bun deps stage
COPY --from=deps-all /app/node_modules ./node_modules
COPY apps/web-ui/package.json ./

# Copy source code and prisma schema
COPY apps/web-ui/ .
COPY libs/prisma/ ./libs/prisma/

# tsconfig.json extends "../../tsconfig.base.json" (correct 2-level-up path in the real
# monorepo layout apps/web-ui/tsconfig.json -> tsconfig.base.json). Flattened into /app here,
# that same relative path resolves to /tsconfig.base.json, so place it there too.
COPY tsconfig.base.json /tsconfig.base.json

# Set Next.js environment for standalone build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_SHARP_PATH=/tmp/node_modules/sharp

# Skip T3 ENV validation during the image build — runtime secrets (DATABASE_URL,
# NEXTAUTH_SECRET, COGNITO_*) are absent here and are injected by the ECS task at
# runtime. The runner stage deliberately does NOT set this, so the container
# fails fast at startup if a required var is missing.
ENV SKIP_ENV_VALIDATION=1

# Set build-time environment variables
ENV NEXT_PUBLIC_AWS_REGION=ap-south-1
ENV NEXT_PUBLIC_APP_TABLE_NAME=NucleusAppTable
ENV NEXT_PUBLIC_AUDIT_TABLE_NAME=NucleusAuditTable
ENV NEXT_PUBLIC_AWS_USE_STS=true

# Generate Prisma client before building.
# The schema `client` generator outputs to "../../node_modules/.prisma/client" which,
# from /app/libs/prisma/ in the Docker context, resolves to /app/node_modules/.prisma/client
# — exactly where the hoisted @prisma/client looks. No path patching needed.
RUN npx prisma@5 generate --schema=./libs/prisma/schema.prisma

# Build the application
RUN npm run build

# ── Stage 4: Production runner (Node) ──
#
# Runner is Node, not Bun, for two hard reasons:
#   1. stdio MCP servers launch as `npx -y <pkg>` and are Node packages with a
#      `#!/usr/bin/env node` shebang — they need node + npm/npx on PATH.
#   2. Bun does not implement `node:v8` (`isBuildingSnapshot`), which the
#      MongoDB LangGraph checkpointer reaches on the deep-agent approve path.
# Next's standalone server.js is a Node artifact and the builder stage above is
# already node:20-slim, so this is the native runtime for it.
FROM node:20-slim AS runner
WORKDIR /app

# Install system dependencies, AWS CLI, Python3 (for uvx/MCP servers)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    git \
    jq \
    less \
    groff \
    grep \
    openssl \
    python3 \
    python3-venv && \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip" && \
    unzip -q awscliv2.zip && \
    ./aws/install && \
    rm -rf aws awscliv2.zip && \
    rm -rf /var/lib/apt/lists/*

# Install uv (Python package manager) for uvx MCP server support
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    cp /root/.local/bin/uv /usr/local/bin/uv && \
    cp /root/.local/bin/uvx /usr/local/bin/uvx && \
    chmod +x /usr/local/bin/uv /usr/local/bin/uvx

# Set environment variables.
# HOME + the cache dirs must be writable by the non-root `node` user: npx stages
# packages under $HOME/.npm/_npx, uvx under $UV_CACHE_DIR, and `mcp-remote`
# persists its OAuth tokens under $HOME/.mcp-auth. These keys are on the
# buildStdioEnv() allowlist in lib/agent/mcp-manager.ts, so they reach the
# spawned MCP subprocess.
ENV PORT=3000 \
    HOSTNAME="0.0.0.0" \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_AWS_REGION=ap-south-1 \
    NEXT_PUBLIC_APP_TABLE_NAME=NucleusAppTable \
    NEXT_PUBLIC_AUDIT_TABLE_NAME=NucleusAuditTable \
    NEXT_PUBLIC_AWS_USE_STS=true \
    HOME=/home/node \
    NPM_CONFIG_CACHE=/home/node/.npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    XDG_CACHE_HOME=/home/node/.cache \
    UV_CACHE_DIR=/home/node/.cache/uv

# Download RDS CA bundle for TLS connections
RUN curl -sSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    -o /etc/ssl/certs/rds-combined-ca-bundle.pem

# Create necessary directories
RUN mkdir -p /tmp/cache && \
    mkdir -p .next/cache

# Copy built application assets
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

# Copy standalone build output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy generated Prisma client (not included in standalone output)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Copy Prisma schema + migrations for migrate deploy at startup
COPY --from=builder /app/libs/prisma ./libs/prisma

# Create symbolic link for cache
RUN ln -sf /tmp/cache ./.next/cache

# Copy entrypoint script
COPY apps/web-ui/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Set proper permissions (incl. the npx / uvx / mcp-remote writable cache dirs)
RUN mkdir -p /home/node/.npm /home/node/.cache/uv /home/node/.mcp-auth && \
    chown -R node:node /app /tmp/cache /home/node

# Switch to non-root user
USER node

# Warm the npx cache for the MCP servers we ship support for, so the first agent
# run does not pay a cold npm-registry fetch (and still works if egress stalls).
# `npm exec --package=<pkg> -- true` populates $HOME/.npm/_npx under the same key
# `npx -y <pkg>` uses, without launching the server's stdio loop. Best-effort:
# a registry hiccup at build time must not fail the image.
RUN npm exec --yes --package=@modelcontextprotocol/server-slack -- true > /dev/null 2>&1 || \
      echo "WARN: could not pre-warm npx cache for @modelcontextprotocol/server-slack"; \
    npm exec --yes --package=mcp-remote -- true > /dev/null 2>&1 || \
      echo "WARN: could not pre-warm npx cache for mcp-remote"

EXPOSE 3000

# Entrypoint: retry DB connection, run Prisma migrations, then start Next.js via Node
ENTRYPOINT ["/app/docker-entrypoint.sh"]
