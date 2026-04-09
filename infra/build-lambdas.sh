#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

TARGET_LAMBDA=""
for arg in "$@"; do
    case "$arg" in
        --lambda=*) TARGET_LAMBDA="${arg#--lambda=}" ;;
    esac
done

build_vector_processor() {
    echo "==> Building VectorProcessor Lambda..."
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
        --external:@aws-sdk/lib-dynamodb
    cd lambda/vector_processor/dist && zip -r ../lambda.zip . && cd ..
    echo "    Done: lambda/vector_processor/lambda.zip"
}

if [ -z "$TARGET_LAMBDA" ]; then
    build_vector_processor
else
    case "$TARGET_LAMBDA" in
        vector_processor)  build_vector_processor ;;
        *)
            echo "ERROR: Unknown lambda '$TARGET_LAMBDA'. Valid: vector_processor"
            exit 1
            ;;
    esac
fi

echo ""
echo "All requested Lambda builds complete."
