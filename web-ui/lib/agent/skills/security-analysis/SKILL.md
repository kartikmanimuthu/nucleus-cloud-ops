---
name: Security Analysis
description: Expert in AWS security best practices, IAM analysis, and compliance checking.
---

# Security Analysis Engineer

## Overview

This skill provides systematic security analysis and auditing capabilities for AWS infrastructure, focusing on IAM policies, security groups, encryption, and compliance best practices.

## Core Capabilities

- IAM role and policy auditing
- Security group configuration review
- Encryption verification (EBS, RDS, S3)
- CloudTrail log analysis for suspicious activity
- Compliance checking against AWS best practices
- Security vulnerability identification

## Instructions

### 1. 🔒 READ-ONLY MODE & CONSTRAINTS

**CRITICAL:** You are a strictly READ-ONLY agent. 
You can ONLY analyze and report on security findings. You cannot:
- Modify IAM policies
- Update security groups
- Enable encryption
- Remediate vulnerabilities

Always provide clear recommendations for remediation that the user can implement.

### 2. IAM Security Audit

**Step 1: List IAM Users**

```bash
aws iam list-users --profile <profile> --query 'Users[*].[UserName,CreateDate,PasswordLastUsed]' --output table
```

**Step 2: Identify Users Without MFA**

```bash
aws iam list-users --profile <profile> | jq -r '.Users[].UserName' | while read user; do
  mfa=$(aws iam list-mfa-devices --user-name "$user" --profile <profile> --query 'MFADevices' --output json)
  if [ "$mfa" == "[]" ]; then
    echo "❌ $user: No MFA device"
  else
    echo "✅ $user: MFA enabled"
  fi
done
```

**Step 3: Find Users With Old Access Keys**

```bash
aws iam list-users --profile <profile> --query 'Users[*].UserName' --output text | while read user; do
  aws iam list-access-keys --user-name "$user" --profile <profile> --query 'AccessKeyMetadata[*].[AccessKeyId,CreateDate,Status]' --output table
done
```

**Recommendation:** Keys older than 90 days should be rotated.

**Step 4: Audit Overly Permissive Policies**

```bash
# List all customer-managed policies
aws iam list-policies --scope Local --profile <profile> --query 'Policies[*].[PolicyName,Arn]' --output table

# Get policy version details
aws iam get-policy-version \
  --policy-arn <policy-arn> \
  --version-id <version-id> \
  --profile <profile> \
  --query 'PolicyVersion.Document' --output json
```

**Red flags to look for:**
- `"Effect": "Allow", "Action": "*", "Resource": "*"` (Full admin access)
- Overly broad S3 permissions (`s3:*`)
- Unrestricted `iam:*` permissions

**Step 5: Find Unused IAM Roles**

```bash
aws iam list-roles --profile <profile> --query 'Roles[*].[RoleName,CreateDate]' --output table

# Check last used
aws iam get-role --role-name <role-name> --profile <profile> --query 'Role.RoleLastUsed'
```

**Recommendation:** Roles unused for >90 days should be reviewed for deletion.

### 3. Security Group Audit

**Step 1: List All Security Groups**

```bash
aws ec2 describe-security-groups --profile <profile> --query 'SecurityGroups[*].[GroupId,GroupName,Description]' --output table
```

**Step 2: Find Security Groups With Unrestricted Access**

```bash
aws ec2 describe-security-groups --profile <profile> --query 'SecurityGroups[?IpPermissions[?IpRanges[?CidrIp==`0.0.0.0/0`]]].[GroupId,GroupName,IpPermissions]' --output json
```

**Critical findings:**
- **SSH (port 22) open to 0.0.0.0/0**: Major security risk
- **RDP (port 3389) open to 0.0.0.0/0**: Major security risk
- **Database ports (3306, 5432, 1433) open to 0.0.0.0/0**: Critical vulnerability

**Better practice:** Restrict to specific IP ranges or use bastion hosts.

**Step 3: Find Unused Security Groups**

```bash
# Get all SGs
aws ec2 describe-security-groups --profile <profile> --query 'SecurityGroups[*].GroupId' --output text > /tmp/all-sgs.txt

# Get SGs attached to instances
aws ec2 describe-instances --profile <profile> --query 'Reservations[*].Instances[*].SecurityGroups[*].GroupId' --output text > /tmp/used-sgs.txt

# Compare (requires further processing)
comm -23 <(sort /tmp/all-sgs.txt) <(sort /tmp/used-sgs.txt | uniq)
```

**Step 4: Analyze Egress Rules**

```bash
aws ec2 describe-security-groups --profile <profile> --query 'SecurityGroups[*].[GroupId,GroupName,IpPermissionsEgress]' --output json
```

**Best practice:** Restrict egress to only necessary destinations, not `0.0.0.0/0` for all traffic.

### 4. Encryption Audit

**EBS Volumes - Check Encryption Status:**

```bash
aws ec2 describe-volumes --profile <profile> --query 'Volumes[*].[VolumeId,Encrypted,Size,State]' --output table
```

**Findings:**
- Count unencrypted volumes
- Estimate data-at-rest exposure
- **Recommendation:** Enable EBS encryption by default in account settings

**RDS Databases - Check Encryption:**

```bash
aws rds describe-db-instances --profile <profile> --query 'DBInstances[*].[DBInstanceIdentifier,StorageEncrypted,Engine]' --output table
```

**Critical:** Production databases MUST be encrypted.

**S3 Buckets - Check Encryption and Public Access:**

```bash
# List buckets
aws s3api list-buckets --profile <profile> --query 'Buckets[*].Name' --output text | while read bucket; do
  echo "Bucket: $bucket"
  
  # Check encryption
  aws s3api get-bucket-encryption --bucket $bucket --profile <profile> 2>&1 | grep -q "ServerSideEncryptionConfigurationNotFoundError" && echo "  ❌ No encryption" || echo "  ✅ Encrypted"
  
  # Check public access block
  aws s3api get-public-access-block --bucket $bucket --profile <profile> 2>&1 | grep -q "NoSuchPublicAccessBlockConfiguration" && echo "  ❌ No public access block" || echo "  ✅ Public access blocked"
done
```

**Critical findings:**
- Buckets without encryption
- Buckets without public access blocks
- Buckets with public policies

### 5. CloudTrail Audit

**Verify CloudTrail is Enabled:**

```bash
aws cloudtrail describe-trails --profile <profile> --query 'trailList[*].[Name,IsMultiRegionTrail,LogFileValidationEnabled,S3BucketName]' --output table
```

**Requirements:**
- At least one trail enabled
- Multi-region trail recommended
- Log file validation enabled
- Logs stored in secure S3 bucket

**Search for Suspicious Activity (Last 24 hours):**

```bash
# Failed console logins
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=ConsoleLogin \
  --start-time $(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S) \
  --profile <profile> \
  --query 'Events[?contains(CloudTrailEvent, `"errorCode"`)]' --output json

# Unauthorized API calls
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=UnauthorizedOperation \
  --start-time $(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S) \
  --profile <profile>

# Root account usage
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=Username,AttributeValue=root \
  --start-time $(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%S) \
  --profile <profile>
```

**Red flags:**
- Root account activity (root should rarely be used)
- Multiple failed login attempts
- Unusual API call patterns
- Access from unexpected IP addresses or locations

### 6. Compliance Checks

**CIS AWS Foundations Benchmark - Key Checks:**

**1. Password Policy:**
```bash
aws iam get-account-password-policy --profile <profile>
```

Requirements:
- Minimum length: 14 characters
- Require uppercase, lowercase, numbers, symbols
- Password expiration: 90 days

**2. Root Account:**
```bash
# Check root access keys
aws iam get-account-summary --profile <profile> --query 'SummaryMap.AccountAccessKeysPresent'
```

**Should be:** 0 (no root access keys)

**3. CloudWatch Alarms for Security Events:**

Check if alarms exist for:
- Unauthorized API calls
- Console login without MFA
- Root account usage
- IAM policy changes
- Security group changes

**4. VPC Flow Logs:**
```bash
aws ec2 describe-flow-logs --profile <profile> --query 'FlowLogs[*].[FlowLogId,ResourceId,TrafficType,LogDestinationType]' --output table
```

**Recommendation:** Enable VPC Flow Logs for network traffic analysis.

### 7. Multi-Account Security Posture

When analyzing security across multiple accounts:

1. **Assess each account independently**
2. **Compare security configurations:**
   - IAM policies and roles
   - Security group patterns
   - Encryption usage
   - CloudTrail configuration
3. **Identify inconsistencies:**
   - Production vs non-production security gaps
   - Accounts with weaker configurations
4. **Provide unified recommendations**

### 8. Security Report Structure

When generating a security audit report:

**1. Executive Summary**
- Overall security posture (High/Medium/Low risk)
- Critical findings count
- High/Medium/Low severity breakdown

**2. Critical Findings** (Immediate action required)
- Unrestricted SSH/RDP access
- Unencrypted databases with sensitive data
- IAM users without MFA
- Public S3 buckets

**3. High Priority** (Address within 30 days)
- Overly permissive IAM policies
- Old access keys (>90 days)
- Unencrypted EBS volumes
- Missing CloudTrail
- Security groups with 0.0.0.0/0 on sensitive ports

**4. Medium Priority** (Address within 90 days)
- Unused IAM roles
- Unused security groups
- Password policy not compliant
- Missing VPC flow logs

**5. Best Practice Recommendations**
- Enable AWS Config for compliance monitoring
- Implement AWS GuardDuty for threat detection
- Use AWS Security Hub for centralized security view
- Regular access reviews and audits

## Best Practices

- **Prioritize by risk**: Critical > High > Medium > Low
- **Provide context**: Explain why each finding is a risk
- **Be specific**: Include resource IDs, policy names, exact configurations
- **Actionable recommendations**: Tell user exactly what to do
- **Compliance mapping**: Reference CIS, NIST, or other frameworks when applicable

## Example Workflow

User: "Perform a security audit of my AWS account"

1. Run IAM audit (users, MFA, access keys,  policies)
2. Audit security groups for unrestricted access
3. Check encryption on EBS, RDS, S3
4. Verify CloudTrail is enabled and logging
5. Search CloudTrail for suspicious activity
6. Check password policy and root account usage
7. Generate security report with prioritized findings
8. Provide specific remediation steps for each finding
