# Multi-stage Dockerfile for Bun-based AWS Lambda Function
# Based on: https://bun.com/docs/guides/deployment/aws-lambda

# Stage 1: AWS Lambda Web Adapter
FROM public.ecr.aws/awsguru/aws-lambda-adapter:0.9.0 AS aws-lambda-adapter

# Stage 2: Build and Runtime
FROM oven/bun:1-debian AS runtime

# Copy the Lambda Web Adapter from stage 1
COPY --from=aws-lambda-adapter /lambda-adapter /opt/extensions/lambda-adapter

# Set required environment variables for Lambda
ENV PORT=8080
ENV NODE_ENV=production

# Set Lambda working directory
WORKDIR /var/task

# Copy package files
COPY package.json bun.lock* ./

# Install production dependencies using Bun
# --frozen-lockfile ensures reproducible builds
# --production excludes devDependencies
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Build the application (if needed, though Bun can run TypeScript directly)
# RUN bun build src/index.ts --target=bun --outfile=dist/index.js --minify

# For Lambda, we'll run TypeScript directly for simplicity
# Bun's JIT compilation is fast enough that we don't need pre-compilation

# Set the entrypoint
# Lambda will invoke the exported handler function
CMD ["bun", "run", "src/index.ts"]
