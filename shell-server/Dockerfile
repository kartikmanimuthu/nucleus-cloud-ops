# syntax=docker/dockerfile:1
FROM node:20.9.0-slim AS builder

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src/ ./src/

RUN npm install && npm run build

# ─── Runtime ────────────────────────────────────────────────────────────────
FROM node:20.9.0-slim

# Install AWS CLI v2, jq, git, python3, and PTY dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        unzip \
        jq \
        git \
        python3 \
        python3-pip \
        ca-certificates \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws \
    && apt-get remove -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Create non-root shell user
RUN groupadd --gid 1001 shelluser \
    && useradd --uid 1001 --gid shelluser --shell /bin/bash --create-home shelluser

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Drop privileges
USER shelluser

ENV NODE_ENV=production \
    SHELL_SERVER_PORT=3001

EXPOSE 3001

CMD ["node", "dist/index.js"]
