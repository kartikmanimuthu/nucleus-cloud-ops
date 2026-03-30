#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Optional --lambda=<name> arg to build just one lambda
TARGET_LAMBDA=""
for arg in "$@"; do
    case "$arg" in
        --lambda=*) TARGET_LAMBDA="${arg#--lambda=}" ;;
    esac
done

build_scheduler() {
    echo "==> Building Scheduler Lambda..."
    cd "$PROJECT_ROOT/lambda/scheduler"
    npm ci --omit=dev
    npx esbuild src/index.ts \
        --bundle \
        --platform=node \
        --target=node20 \
        --format=cjs \
        --outfile=dist/index.js \
        --external:@aws-sdk/*
    cd dist && zip -r ../lambda.zip index.js && cd ..
    echo "    Done: lambda/scheduler/lambda.zip"
}

build_vector_processor() {
    echo "==> Building VectorProcessor Lambda..."
    # Run esbuild from project root so it resolves root node_modules
    # (@aws-sdk/client-s3vectors and @prisma/client are in root node_modules)
    # Externalize standard Lambda runtime SDKs; bundle client-s3vectors (not in runtime)
    # Externalize @prisma/client — engine binary cannot be bundled; copy it separately
    cd "$PROJECT_ROOT"
    mkdir -p lambda/vector_processor/dist
    npx esbuild lambda/vector_processor/src/index.ts \
        --bundle \
        --platform=node \
        --target=node20 \
        --format=cjs \
        --outfile=lambda/vector_processor/dist/index.js \
        --external:@aws-sdk/client-s3 \
        --external:@aws-sdk/client-bedrock-runtime \
        --external:@aws-sdk/client-dynamodb \
        --external:@aws-sdk/lib-dynamodb \
        --external:@prisma/client \
        --external:.prisma/client
    # Copy Prisma client (engine binary + generated types) into dist
    mkdir -p lambda/vector_processor/dist/node_modules/@prisma
    mkdir -p lambda/vector_processor/dist/node_modules/.prisma
    cp -r node_modules/@prisma/client lambda/vector_processor/dist/node_modules/@prisma/
    cp -r node_modules/.prisma/client lambda/vector_processor/dist/node_modules/.prisma/
    cd lambda/vector_processor/dist && zip -r ../lambda.zip . && cd ..
    echo "    Done: lambda/vector_processor/lambda.zip"
}

build_kb_sync_processor() {
    echo "==> Building KBSyncProcessor Lambda..."
    cd "$PROJECT_ROOT/lambda/kb_sync_processor"
    npm ci --omit=dev
    npx esbuild src/index.ts \
        --bundle \
        --platform=node \
        --target=node20 \
        --format=cjs \
        --outfile=dist/index.js \
        --external:@aws-sdk/client-s3 \
        --external:@aws-sdk/client-bedrock-runtime \
        --external:@aws-sdk/client-dynamodb \
        --external:@aws-sdk/lib-dynamodb
    # Copy node_modules that must be bundled (not in Lambda runtime)
    mkdir -p dist/node_modules
    cp -r node_modules/pdf-parse dist/node_modules/
    if [ -d "node_modules/@aws-sdk/client-s3vectors" ]; then
        mkdir -p dist/node_modules/@aws-sdk
        cp -r node_modules/@aws-sdk/client-s3vectors dist/node_modules/@aws-sdk/
    fi
    cd dist && zip -r ../lambda.zip . && cd ..
    echo "    Done: lambda/kb_sync_processor/lambda.zip"
}

if [ -z "$TARGET_LAMBDA" ]; then
    build_scheduler
    build_vector_processor
    build_kb_sync_processor
else
    case "$TARGET_LAMBDA" in
        scheduler)         build_scheduler ;;
        vector_processor)  build_vector_processor ;;
        kb_sync_processor) build_kb_sync_processor ;;
        *)
            echo "ERROR: Unknown lambda '$TARGET_LAMBDA'. Valid: scheduler, vector_processor, kb_sync_processor"
            exit 1
            ;;
    esac
fi

echo ""
echo "All requested Lambda builds complete."
