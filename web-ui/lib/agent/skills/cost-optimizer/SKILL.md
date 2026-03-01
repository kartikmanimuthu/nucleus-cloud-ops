---
name: Cost Optimizer
description: Identify cost optimization opportunities by analyzing individual AWS resources and services to find waste, idle resources, and right-sizing opportunities.
tier: read-only
date: 2026-03-01
---

# Cost Optimizer

## Overview

This skill performs **deep resource-level analysis** to identify specific optimization opportunities. It queries Cost Explorer to understand spending patterns, then drills into individual resources (EC2, RDS, EBS, ECS, Lambda, etc.) to find waste and inefficiencies.

> **READ-ONLY skill** — analyzes and recommends only. Does not modify resources.

## Core Capabilities

- Query Cost Explorer to identify high-cost services
- Analyze individual EC2 instances for idle/underutilized resources
- Identify unattached EBS volumes and old snapshots
- Find idle RDS databases with low connections
- Detect over-provisioned Lambda functions
- Analyze ECS task utilization
- Calculate right-sizing recommendations with specific instance IDs
- Estimate dollar savings per optimization

## Workflow

### 1. Cost Explorer Analysis

**Get service-level costs (last 30 days):**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=SERVICE \
  --output json \
  --profile <profile>
```

**Identify top 5 cost drivers** — parse and sort by cost descending.

### 2. EC2 Deep Dive

**List all running instances:**

```bash
aws ec2 describe-instances \
  --filters "Name=instance-state-name,Values=running" \
  --query 'Reservations[*].Instances[*].[InstanceId,InstanceType,LaunchTime,Tags[?Key==`Name`].Value|[0],State.Name]' \
  --output table \
  --profile <profile>
```

**Check CPU utilization (last 7 days per instance):**

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=<instance-id> \
  --start-time $(date -v-7d +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Average,Maximum \
  --output json \
  --profile <profile>
```

**Optimization criteria:**
- **Idle**: Avg CPU <5%, Max CPU <10% → candidate for termination
- **Underutilized**: Avg CPU <20% → right-size to smaller instance type
- **Stopped instances with EBS**: Check if still needed, snapshot and delete if not

**Calculate savings:**
- Get hourly cost from AWS Pricing API or use estimates
- Monthly savings = hourly_cost × 730 hours

### 3. EBS Volume Analysis

**Find unattached volumes:**

```bash
aws ec2 describe-volumes \
  --filters "Name=status,Values=available" \
  --query 'Volumes[*].[VolumeId,Size,VolumeType,CreateTime]' \
  --output table \
  --profile <profile>
```

**Savings:** `Size_GB × $0.08/month` (gp3 pricing)

**Find old snapshots (>90 days):**

```bash
aws ec2 describe-snapshots \
  --owner-ids self \
  --query "Snapshots[?StartTime<='$(date -v-90d +%Y-%m-%d)'].[SnapshotId,VolumeSize,StartTime,Description]" \
  --output table \
  --profile <profile>
```

**Savings:** `Size_GB × $0.05/month` (snapshot pricing)

### 4. RDS Deep Dive

**List all RDS instances:**

```bash
aws rds describe-db-instances \
  --query 'DBInstances[*].[DBInstanceIdentifier,DBInstanceClass,Engine,MultiAZ,DBInstanceStatus,AllocatedStorage]' \
  --output table \
  --profile <profile>
```

**Check database connections (last 7 days):**

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=<db-id> \
  --start-time $(date -v-7d +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Average,Maximum \
  --output json \
  --profile <profile>
```

**Check CPU utilization:**

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value=<db-id> \
  --start-time $(date -v-7d +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Average,Maximum \
  --output json \
  --profile <profile>
```

**Optimization opportunities:**
- **Idle DB**: Avg connections <5, CPU <10% → add to scheduler or terminate
- **Multi-AZ in dev/test**: Switch to single-AZ → 50% savings
- **Over-provisioned**: CPU <20% → downsize instance class

### 5. Lambda Analysis

**Get Lambda costs (last 30 days):**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["AWS Lambda"]}}' \
  --output json \
  --profile <profile>
```

**List functions and check invocations:**

```bash
aws lambda list-functions \
  --query 'Functions[*].[FunctionName,MemorySize,Timeout,Runtime]' \
  --output table \
  --profile <profile>

aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value=<function-name> \
  --start-time $(date -v-7d +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Sum \
  --output json \
  --profile <profile>
```

**Check memory utilization:**

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/<function-name> \
  --filter-pattern "Max Memory Used" \
  --start-time $(date -v-7d +%s)000 \
  --limit 50 \
  --profile <profile>
```

**Optimization:**
- Over-provisioned memory → reduce memory allocation
- Unused functions (0 invocations in 30 days) → delete

### 6. ECS Analysis

**List ECS services:**

```bash
aws ecs list-clusters --profile <profile>

aws ecs list-services --cluster <cluster-name> --profile <profile>

aws ecs describe-services \
  --cluster <cluster-name> \
  --services <service-name> \
  --profile <profile>
```

**Check task CPU/memory utilization:**

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS \
  --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=<service-name> Name=ClusterName,Value=<cluster-name> \
  --start-time $(date -v-7d +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Average,Maximum \
  --output json \
  --profile <profile>
```

**Optimization:**
- Over-provisioned tasks → reduce CPU/memory allocation
- Idle services → add to scheduler or scale to 0

### 7. Elastic Load Balancer Analysis

**Find idle load balancers:**

```bash
aws elbv2 describe-load-balancers \
  --query 'LoadBalancers[*].[LoadBalancerName,LoadBalancerArn,State.Code,Type]' \
  --output table \
  --profile <profile>

aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name RequestCount \
  --dimensions Name=LoadBalancer,Value=<lb-name> \
  --start-time $(date -v-7d +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Sum \
  --output json \
  --profile <profile>
```

**Optimization:** Load balancers with 0 requests → delete (saves ~$16/month per ALB)

### 8. NAT Gateway Analysis

**List NAT Gateways:**

```bash
aws ec2 describe-nat-gateways \
  --query 'NatGateways[*].[NatGatewayId,State,SubnetId,VpcId]' \
  --output table \
  --profile <profile>
```

**Check data transfer:**

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/NATGateway \
  --metric-name BytesOutToDestination \
  --dimensions Name=NatGatewayId,Value=<nat-id> \
  --start-time $(date -v-7d +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Sum \
  --output json \
  --profile <profile>
```

**Optimization:**
- Dev/test NAT gateways → consider NAT instances or VPC endpoints
- Unused NAT gateways → delete (saves ~$32/month + data transfer)

## Output Format

Structure optimization report as:

```
# Cost Optimization Report
Account: <account-name> (<account-id>)
Analysis Period: <date-range>

## Executive Summary
- Total Monthly Cost: $X,XXX
- Identified Savings: $X,XXX/month (XX%)
- Number of Recommendations: XX

## High-Impact Quick Wins

### 1. Unattached EBS Volumes (Immediate)
- vol-xxxxx (100 GB gp3) - $8/month
- vol-yyyyy (500 GB gp3) - $40/month
**Total Savings: $48/month**

### 2. Idle EC2 Instances (Immediate)
- i-xxxxx (t3.large, avg CPU 2%) - $53/month
- i-yyyyy (m5.xlarge, avg CPU 4%) - $140/month
**Total Savings: $193/month**

## Medium-Impact Optimizations

### 3. RDS Right-Sizing (Requires Testing)
- db-prod-replica (db.r5.2xlarge, avg CPU 15%) → db.r5.xlarge
  **Savings: $280/month**

### 4. Multi-AZ in Non-Production (Requires Planning)
- db-staging (db.t3.medium Multi-AZ) → Single-AZ
  **Savings: $30/month**

## Long-Term Strategic Optimizations

### 5. Lambda Memory Optimization
- function-a (1024 MB, avg used 256 MB) → 512 MB
  **Savings: $12/month**

### 6. Scheduler Candidates
- 5 EC2 instances in dev environment (8AM-6PM Mon-Fri)
  **Savings: $450/month (70% reduction)**

## Total Potential Savings: $1,013/month (28% reduction)
```

## Best Practices

- **Always verify resource state** before recommending deletion
- **Check tags** to understand resource purpose (Environment, Owner, Application)
- **Calculate ROI** in dollars, not percentages
- **Prioritize by impact** — sort by monthly savings descending
- **Consider dependencies** — don't recommend deleting resources with active connections
- **Provide specific IDs** — every recommendation must include exact resource identifier
- **Estimate conservatively** — use lower-bound savings estimates
- **Check CloudWatch metrics** for at least 7 days of data

## Safety Guidelines

- Never recommend deleting production resources without explicit user confirmation
- Always check resource tags for `Environment` and `Owner` before optimization
- Verify resources are truly idle (check multiple metrics: CPU, network, connections)
- For right-sizing, recommend one instance class smaller (not aggressive downsizing)
- Suggest testing in non-production first for any configuration changes
