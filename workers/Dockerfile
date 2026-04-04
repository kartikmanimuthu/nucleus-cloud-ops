# Multi-stage Dockerfile for pg-boss workers on ECS Fargate (ARM64)
# Build context: project root (not workers/) — required to include prisma/

FROM public.ecr.aws/docker/library/node:20.9.0-slim AS builder
WORKDIR /app

# Copy package files
COPY workers/package*.json ./

# Install all dependencies for build
RUN npm ci && npm cache clean --force

# Copy source code and prisma schema
COPY workers/ .
COPY prisma/ ./prisma/

# Generate Prisma client
RUN npx prisma@5 generate --schema=./prisma/schema.prisma

# Build TypeScript
RUN npm run build

FROM public.ecr.aws/docker/library/node:20.9.0-slim AS runner
WORKDIR /app

# Install openssl for Prisma
RUN apt-get update && apt-get install -y openssl curl && rm -rf /var/lib/apt/lists/*

# Download RDS CA bundle for TLS connections
RUN curl -sSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    -o /etc/ssl/certs/rds-combined-ca-bundle.pem

# Copy package files and install production deps only
COPY workers/package*.json ./
RUN npm ci --only=production --omit=dev && npm cache clean --force

# Copy built output
COPY --from=builder /app/dist ./dist

# Copy Prisma schema + generated client
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

ENV NODE_ENV=production

# Non-root user
USER node

CMD ["node", "dist/index.js"]
