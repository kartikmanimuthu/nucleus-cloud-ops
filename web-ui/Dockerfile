FROM public.ecr.aws/docker/library/node:20.9.0-slim AS deps
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production --omit=dev --legacy-peer-deps && \
    npm cache clean --force

FROM public.ecr.aws/docker/library/node:20.9.0-slim AS builder
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies for build
RUN npm ci --legacy-peer-deps && \
    npm cache clean --force

# Copy source code
COPY . .

# Set Next.js environment for standalone build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_SHARP_PATH=/tmp/node_modules/sharp

# Set build-time environment variables for Next.js client-side access
ENV NEXT_PUBLIC_AWS_REGION=ap-south-1
ENV NEXT_PUBLIC_APP_TABLE_NAME=NucleusAppTable
ENV NEXT_PUBLIC_AUDIT_TABLE_NAME=NucleusAuditTable
ENV NEXT_PUBLIC_AWS_USE_STS=true

# Build the application
RUN npm run build

FROM public.ecr.aws/docker/library/node:20.9.0-slim AS runner

# Install AWS Lambda Web Adapter
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 /lambda-adapter /opt/extensions/lambda-adapter

# Set environment variables
ENV PORT=8080 \
    AWS_LWA_INVOKE_MODE=response_stream \
    NODE_ENV=production \
    AWS_LWA_ENABLE_COMPRESSION=true \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXTAUTH_SECRET='iojifjifjfijffjijiehyudfytwfdtrdreswrsrxedctfvygbuhnjmk' \
    NEXT_PUBLIC_AWS_REGION=ap-south-1 \
    NEXT_PUBLIC_APP_TABLE_NAME=NucleusAppTable \
    NEXT_PUBLIC_AUDIT_TABLE_NAME=NucleusAuditTable \
    NEXT_PUBLIC_AWS_USE_STS=true \
    NEXT_PUBLIC_TESTING1='testing1'


WORKDIR /app

# Create necessary directories
RUN mkdir -p /tmp/cache && \
    mkdir -p .next/cache

# Copy built application from builder stage
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

# Copy standalone build output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy generated Prisma client from builder (prisma generate runs there, not in deps)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Create symbolic link for cache
RUN ln -sf /tmp/cache ./.next/cache

# Set proper permissions
RUN chown -R node:node /app && \
    chown -R node:node /tmp/cache

# Expose port
EXPOSE 8080

# Start the application (run as root for Lambda Web Adapter compatibility)
CMD ["node", "server.js"]