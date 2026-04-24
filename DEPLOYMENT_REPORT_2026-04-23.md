# Deployment Report — Nucleus Cloud Ops
**Date:** 2026-04-23  
**Deployed by:** kartikmanimuthu@smcindiaonline.com  
**AWS Account:** 970547372609  
**Region:** ap-south-1  
**AWS Profile:** STX-CLOUD-PLATFORM  
**Branch:** infra-changes  

---

## Summary

Full fresh deployment of the Nucleus Cloud Ops platform to AWS ap-south-1. Both Pulumi stacks — `infra/networking` and `infra/compute` — were deployed from scratch on a new VPC. The application is live at:

**https://d2o00a2uwp9po0.cloudfront.net**

---

## What Was Deployed

### Networking Stack (`infra/networking`)
| Resource | Name / ID |
|---|---|
| VPC | `nucleus-vpc` — vpc-0e4a3da2c4998a21e (10.0.0.0/16) |
| Public Subnets | ap-south-1a + ap-south-1b |
| Private Subnets | ap-south-1a + ap-south-1b |
| Database Subnets | ap-south-1a + ap-south-1b |
| Intra Subnets | ap-south-1a + ap-south-1b |
| NAT Gateways | 2 (one per AZ) |
| Internet Gateway | 1 |
| Route Tables | 8 (public, private, database, intra per AZ) |
| S3 VPC Endpoint | Gateway endpoint for S3 |
| RDS Subnet Group | `nucleus-db-subnet-group` |

**Total resources created:** 38  
**Duration:** ~4 minutes

---

### Compute Stack (`infra/compute`)
| Resource | Value |
|---|---|
| ECS Cluster | `nucleus-cloud-ops-ecs-cluster` |
| Web UI ECS Service | `nucleus-cloud-ops-web-ui-service` |
| Workers ECS Service | `nucleus-cloud-ops-workers-service` |
| RDS PostgreSQL | `nucleus-cloud-ops-postgres.cxoucc8oef6b.ap-south-1.rds.amazonaws.com` |
| ALB | `nucleus-cloud-ops-alb-1107316905.ap-south-1.elb.amazonaws.com` |
| CloudFront Distribution | `E2DWYDW535RG6V` → https://d2o00a2uwp9po0.cloudfront.net |
| ECR (Web UI) | `970547372609.dkr.ecr.ap-south-1.amazonaws.com/nucleus-cloud-ops-web-ui` |
| ECR (Workers) | `970547372609.dkr.ecr.ap-south-1.amazonaws.com/nucleus-cloud-ops-workers` |
| Cognito User Pool | `ap-south-1_7OQFUNzgj` |
| Cognito Identity Pool | `ap-south-1:f5bcb1a7-ddc0-4482-99ab-71d068290740` |
| Bastion EC2 | `i-0495ea2b853ce6c8e` (SSM-only, private subnet) |
| SNS Topic | `nucleus-cloud-ops-sns-topic` |
| Secrets Manager | `nucleus-cloud-ops/nextauth-secret`, `nucleus-cloud-ops/database-url` |

**Total resources created:** 74 (across both stacks)  
**Duration:** ~4 minutes (networking) + ~8 minutes (compute, including Docker builds)

---

## Challenges Encountered

### 1. VPC Limit Exceeded
**Error:** `VpcLimitExceeded: The maximum number of VPCs has been reached`

The AWS account had 5 VPCs in ap-south-1 (the default limit), all in use:
- `aws-controltower-VPC` (172.31.0.0/16)
- `llm-inferencing-vpc` — had a running g6.2xlarge instance
- `stx-plt-chatbot-analytics-4rft`
- `nucleus-app-vpc` — old CDK stack VPC (10.0.0.0/16)
- `chat-llm-poc-vpc` — had running instances

None could be safely deleted. A Service Quotas increase request was submitted via CLI and auto-approved within ~5 minutes (limit raised to 10).

**Resolution:** `aws service-quotas request-service-quota-increase --service-code vpc --quota-code L-F678F1CE --desired-value 10`

---

### 2. Non-ASCII Character in Security Group Description
**Error:** `InvalidParameterValue: Character sets beyond ASCII are not supported`

The bastion security group description contained an em dash (`—`):
```
"Bastion — SSM only, no inbound SSH"
```
AWS EC2 security group descriptions only accept ASCII characters.

**Resolution:** Replaced the em dash with a regular hyphen in `infra/compute/index.ts`:
```
"Bastion - SSM only, no inbound SSH"
```

---

### 3. S3 Tables CloudFormation Stack — Bucket Already Exists
**Error:** `The bucket that you tried to create already exists, and you own it (S3Tables, 409)`

The compute stack wraps an S3 Tables table bucket (`nucleus-app-inventory-bucket`) in a CloudFormation stack. This bucket was created by the old CDK stack in January 2026 and still exists. CloudFormation tried to create it fresh, hit a 409 conflict, and rolled back to `ROLLBACK_COMPLETE` state.

This happened twice across two deploy attempts:
- First attempt: CFN stack went to `ROLLBACK_COMPLETE` — deleted it from AWS and from Pulumi state
- Second attempt: Pulumi tried to update the same ARN (now `DELETE_COMPLETE`) — failed again

**Resolution:** The S3 Tables stack is not needed in the current lean setup. Removed the entire `s3TablesCfnStack` resource and its `fs.readFileSync` from `infra/compute/index.ts`. The existing bucket and its data remain untouched in AWS.

---

### 4. Pulumi State Drift (grpc connection closing)
After the first partial compute deploy, Pulumi state had partially-created resources. Subsequent runs showed `grpc: the client connection is closing` errors on the ECR image resources. These were caused by the CFN stack failure interrupting the Pulumi process mid-run, leaving the state lock in an inconsistent state.

**Resolution:** Cleared the stale CFN resource from Pulumi state with `pulumi state delete` and re-ran `pulumi up`, which correctly resumed from the last known good state.

---

## Stack Outputs

```
cloudFrontUrl        : https://d2o00a2uwp9po0.cloudfront.net
postgresEndpoint     : nucleus-cloud-ops-postgres.cxoucc8oef6b.ap-south-1.rds.amazonaws.com
bastionInstanceId    : i-0495ea2b853ce6c8e
ecsClusterName       : nucleus-cloud-ops-ecs-cluster
cognitoUserPoolId    : ap-south-1_7OQFUNzgj
ecrRepositoryUri     : 970547372609.dkr.ecr.ap-south-1.amazonaws.com/nucleus-cloud-ops-web-ui
albDnsName           : nucleus-cloud-ops-alb-1107316905.ap-south-1.elb.amazonaws.com
```

---

## Next Steps

### Immediate (Required Before Production Use)

1. **Update `appUrl` config to new CloudFront URL**  
   The stack config still references the old URL (`d11lr8aqp8vqde`). Update and redeploy:
   ```bash
   cd infra/compute
   PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=STX-CLOUD-PLATFORM \
     pulumi config set appUrl "https://d2o00a2uwp9po0.cloudfront.net" --stack prod
   PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=STX-CLOUD-PLATFORM pulumi up --stack prod --yes
   ```

2. **Run post-deploy smoke tests**
   ```bash
   npx playwright test tests/e2e/ --project=chromium
   ```
   Verify CloudFront URL responds 200 and ECS service desired count matches running count.

3. **Run database migrations**  
   Open an SSM tunnel to the bastion and run Prisma migrations against the new RDS instance:
   ```bash
   AWS_PROFILE=STX-CLOUD-PLATFORM aws ssm start-session \
     --target i-0495ea2b853ce6c8e \
     --document-name AWS-StartPortForwardingSessionToRemoteHost \
     --parameters '{"host":["nucleus-cloud-ops-postgres.cxoucc8oef6b.ap-south-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5433"]}'
   ```

4. **Seed Cognito with initial users**  
   The new Cognito user pool (`ap-south-1_7OQFUNzgj`) is empty. Create the initial admin user.

---

### Short-Term (Cleanup)

5. **Decommission old CDK VPC and resources**  
   `nucleus-app-vpc` (vpc-083db563cab25a99a) and its subnets/NAT gateways/route tables are orphaned CDK resources. Once the new stack is verified stable, destroy the old CDK stack:
   ```bash
   npx cdk destroy nucleus-app-NetworkingStack --profile STX-CLOUD-PLATFORM
   ```
   This will free up one VPC slot and eliminate ~$70/month in NAT Gateway costs.

6. **Fix deprecated Pulumi resource warnings**  
   Three S3 resources use the deprecated `BucketV2` and `BucketLifecycleConfigurationV2` APIs. Migrate to `aws.s3.Bucket` and `aws.s3.BucketLifecycleConfiguration` in `infra/compute/index.ts`.

7. **Verify S3 Tables removal has no downstream impact**  
   The `nucleus-app-inventory-bucket` S3 Tables bucket still exists in AWS but is no longer managed by Pulumi. Confirm whether the discovery Lambda or vector processor still references it. If not needed, it can be left as-is (DeletionPolicy: Retain) or manually deleted.

---

### Medium-Term

8. **Configure CloudFront custom domain**  
   Replace the auto-generated CloudFront URL with a custom domain (e.g., `app.nucleus.yourdomain.com`) via ACM + CloudFront alias.

9. **Set up CloudWatch alarms**  
   Add alarms for ECS service unhealthy task count, RDS CPU/storage, and ALB 5xx error rate.

10. **Enable RDS automated backups and point-in-time recovery**  
    Verify the RDS instance has automated backups enabled with an appropriate retention window (7–14 days recommended).

---

## Code Changes Made During This Deployment

| File | Change |
|---|---|
| `infra/compute/index.ts` | Fixed em dash → hyphen in bastion SG description |
| `infra/compute/index.ts` | Removed `s3TablesCfnStack` and `s3TablesTemplate` (S3 Tables not needed) |
| `infra/networking/Pulumi.prod.yaml` | Added `encryptionsalt` (passphrase provider initialized) |
| `infra/compute/Pulumi.prod.yaml` | Replaced `secretsprovider: passphrase` with `encryptionsalt` |
