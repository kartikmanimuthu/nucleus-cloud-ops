# Multi-stage Dockerfile for pg-boss workers on ECS Fargate (ARM64)
# Uses Bun for dependency installation, build, and production runtime
# Build context: project root (not apps/workers/) — required to include libs/prisma/

# ── Stage 1: Build ──
FROM oven/bun:1-slim AS builder
WORKDIR /app

# Install openssl required by Prisma client generation
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY apps/workers/package.json apps/workers/bun.lock ./

# Install all dependencies
RUN bun install --frozen-lockfile

# Copy source code and prisma schema
COPY apps/workers/ .
COPY libs/prisma/ ./libs/prisma/

# tsconfig.json extends "../../tsconfig.base.json" (correct 2-level-up path in the real
# monorepo layout apps/workers/tsconfig.json -> tsconfig.base.json). Flattened into /app here,
# that same relative path resolves to /tsconfig.base.json, so place it there too.
COPY tsconfig.base.json /tsconfig.base.json

# Remove libs/prisma/.env to avoid conflict with root .env during generate
RUN rm -f libs/prisma/.env

# Generate Prisma client. The schema `client` generator outputs to
# "../../node_modules/.prisma/client" → /app/node_modules/.prisma/client in the Docker
# context (relative to /app/libs/prisma/), where the hoisted @prisma/client looks.
# No path patching needed.
RUN bunx prisma@6 generate --schema=./libs/prisma/schema.prisma

# Build TypeScript
RUN bun run build

# Copy non-TS assets that tsc doesn't emit
RUN cp src/jobs/discovery/scanfile.json dist/jobs/discovery/scanfile.json

# ── Stage 2: Production runner (Bun) ──
FROM oven/bun:1-slim AS runner
WORKDIR /app

# Install openssl + curl for Prisma and RDS CA bundle
RUN apt-get update && apt-get install -y openssl curl && rm -rf /var/lib/apt/lists/*

# Download RDS CA bundle for TLS connections
RUN curl -sSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    -o /etc/ssl/certs/rds-combined-ca-bundle.pem

# Copy built output
COPY --from=builder /app/dist ./dist

# Copy package.json so Bun/Node recognises this as an ESM module ("type": "module")
COPY --from=builder /app/package.json ./package.json

# Copy node_modules from builder — avoids reinstalling @prisma/client from registry
# (freshly installed @prisma/client is uninitialized; generated client must come from builder)
COPY --from=builder /app/node_modules ./node_modules

# Copy Prisma schema + generated client (belt-and-suspenders)
COPY --from=builder /app/libs/prisma ./libs/prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

ENV NODE_ENV=production

# Non-root user
USER bun

CMD ["bun", "run", "dist/index.js"]
