
AWS_PROFILE=STX-APPLICATION-PLATFORM-NON-PROD-ADMIN aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws

export BUILDX_NO_DEFAULT_ATTESTATIONS=1


AWS_PROFILE=STX-APPLICATION-PLATFORM-NON-PROD-ADMIN  npx cdk deploy --all --require-approval never