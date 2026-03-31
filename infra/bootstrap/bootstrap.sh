#!/usr/bin/env bash
set -euo pipefail

# One-time bootstrap for Pulumi S3 backend + KMS secrets provider.
# Run once per AWS account. Requires AWS CLI + PLATFORM-ADMIN profile.
#
# Usage: ./bootstrap.sh
# Prerequisites: aws cli configured with PLATFORM-ADMIN profile

BUCKET_NAME="nucleus-pulumi-state"
REGION="us-east-1"
PROFILE="PLATFORM-ADMIN"
KMS_ALIAS="alias/pulumi-secrets"

echo "==> Creating S3 state bucket: $BUCKET_NAME"
aws s3api create-bucket \
  --bucket "$BUCKET_NAME" \
  --region "$REGION" \
  --profile "$PROFILE"

echo "==> Enabling versioning"
aws s3api put-bucket-versioning \
  --bucket "$BUCKET_NAME" \
  --versioning-configuration Status=Enabled \
  --profile "$PROFILE"

echo "==> Blocking public access"
aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  --profile "$PROFILE"

echo "==> Creating KMS key for Pulumi secrets"
KEY_ID=$(aws kms create-key \
  --description "Pulumi secrets encryption key for nucleus-cloud-ops" \
  --profile "$PROFILE" \
  --region "$REGION" \
  --query 'KeyMetadata.KeyId' \
  --output text)

echo "==> Creating KMS alias: $KMS_ALIAS"
aws kms create-alias \
  --alias-name "$KMS_ALIAS" \
  --target-key-id "$KEY_ID" \
  --profile "$PROFILE" \
  --region "$REGION"

echo "==> Logging into Pulumi S3 backend"
pulumi login "s3://${BUCKET_NAME}?region=${REGION}&awssdk=v2&profile=${PROFILE}"

echo ""
echo "Bootstrap complete."
echo "  S3 bucket: $BUCKET_NAME (versioning enabled, public access blocked)"
echo "  KMS alias: $KMS_ALIAS (key ID: $KEY_ID)"
echo "  Pulumi backend: s3://$BUCKET_NAME"
echo ""
echo "Next: cd infra/networking && npm install && pulumi stack init prod --secrets-provider='awskms://alias/pulumi-secrets'"
