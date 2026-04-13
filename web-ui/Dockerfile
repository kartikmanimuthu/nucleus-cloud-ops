# Multi-stage Dockerfile for Next.js Web UI on ECS Fargate
# Uses Bun for dependency installation, build, and production runtime
# Build context: project root (not web-ui/) — required to include prisma/

# ── Stage 1: Install dependencies with Bun ──
FROM oven/bun:1-slim AS deps
WORKDIR /app

COPY web-ui/package.json web-ui/bun.lock* web-ui/package-lock.json ./

# Install production dependencies only
RUN bun install --frozen-lockfile --production

# ── Stage 2: Build with Bun ──
FROM oven/bun:1-slim AS builder
WORKDIR /app

# Install openssl for Prisma engine binaries
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY web-ui/package.json web-ui/bun.lock* web-ui/package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy source code and prisma schema
COPY web-ui/ .
COPY prisma/ ./prisma/

# Set Next.js environment for standalone build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_SHARP_PATH=/tmp/node_modules/sharp

# Set build-time environment variables
ENV NEXT_PUBLIC_AWS_REGION=ap-south-1
ENV NEXT_PUBLIC_APP_TABLE_NAME=NucleusAppTable
ENV NEXT_PUBLIC_AUDIT_TABLE_NAME=NucleusAuditTable
ENV NEXT_PUBLIC_AWS_USE_STS=true

# Generate Prisma client before building
# In Docker context, web-ui/ contents are at /app/ (not /app/web-ui/),
# so patch the schema output path before generating.
RUN sed -i 's|"../web-ui/node_modules/.prisma/client"|"../node_modules/.prisma/client"|' ./prisma/schema.prisma && \
    bunx prisma@5 generate --schema=./prisma/schema.prisma

# Build the application
RUN bun run build

# ── Stage 3: Production runner (Bun) ──
FROM oven/bun:1-slim AS runner
WORKDIR /app

# Install system dependencies, AWS CLI, Python3 (for uvx/MCP servers)
RUN apt-get update && \
    apt-get install -y \
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
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf aws awscliv2.zip && \
    rm -rf /var/lib/apt/lists/*

# Install uv (Python package manager) for uvx MCP server support
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    cp /root/.local/bin/uv /usr/local/bin/uv && \
    cp /root/.local/bin/uvx /usr/local/bin/uvx && \
    chmod +x /usr/local/bin/uv /usr/local/bin/uvx

# Set environment variables
ENV PORT=3000 \
    HOSTNAME="0.0.0.0" \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_AWS_REGION=ap-south-1 \
    NEXT_PUBLIC_APP_TABLE_NAME=NucleusAppTable \
    NEXT_PUBLIC_AUDIT_TABLE_NAME=NucleusAuditTable \
    NEXT_PUBLIC_AWS_USE_STS=true

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
COPY --from=builder /app/prisma ./prisma

# Create symbolic link for cache
RUN ln -sf /tmp/cache ./.next/cache

# Copy entrypoint script
COPY web-ui/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Set proper permissions
RUN chown -R bun:bun /app /tmp/cache

# Switch to non-root user
USER bun

EXPOSE 3000

# Entrypoint: retry DB connection, run Prisma migrations, then start Next.js via Bun
ENTRYPOINT ["/app/docker-entrypoint.sh"]
