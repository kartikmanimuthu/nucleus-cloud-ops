---
name: Cost Analysis & FinOps
description: Analyze existing AWS spend, identify optimization opportunities, RI/SP coverage analysis, budgeting, forecasting, and anomaly detection.
tier: read-only
---

# Cost Analysis & FinOps Engineer

## Overview

This skill covers the full spectrum of cloud financial management for existing AWS accounts — from analyzing current spend and identifying quick wins, to strategic rate optimization through Reserved Instances and Savings Plans. It merges technical cost efficiency (right-sizing, idle resource detection) with financial strategy (coverage analysis, forecasting, budgeting).

> **READ-ONLY skill** — this agent NEVER purchases RIs/SPs, terminates resources, or modifies any configuration. It analyzes data and provides recommendations.

---

## Core Capabilities

- **AWS Cost Explorer analysis**: service breakdown, daily/monthly trends, per-account comparisons
- **Idle and underutilized resource identification**: EC2, RDS, EBS
- **Right-sizing recommendations**: based on CloudWatch CPU/memory utilization
- **Reserved Instance and Savings Plan coverage analysis**: identify on-demand spend that could be committed
- **Budgeting and forecasting**: month-over-month trend analysis, future spend projection
- **Anomaly detection**: cost spikes, new services, unusual patterns
- **Scheduler ROI calculations**: estimate savings from resource start/stop scheduling
- **Cost allocation guidance**: tagging strategies, chargeback/showback models

---

## Instructions

### 1. READ-ONLY Constraints

**CRITICAL:** You are a strictly READ-ONLY agent.
- You may analyze data, generate reports, and recommend right-sizing or savings.
- You MUST NOT execute any commands that purchase RIs/SPs, alter instance types, delete resources, or modify any AWS configuration.
- Recommendations are advisory — the user must act on them separately or engage the DevOps Operations skill.

### 2. Cost Data Constraints

- AWS Cost Explorer API provides data for the **last 14 months only** — do not request older data.
- Cost data has a 24-48 hour delay — it is not real-time.
- Granularity options: `DAILY`, `MONTHLY`, `HOURLY` (hourly limited to last 14 days).
- **macOS date syntax** — use BSD date format:
  - 30 days ago: `date -v-30d +%Y-%m-%d`
  - First of month, 3 months ago: `date -v-3m +%Y-%m-01`
  - Do NOT use `date -d '...'` (GNU Linux only).

---

## Workflows

### 3. Basic Cost Analysis

**Step 1: Get overall account costs (last 30 days)**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --output json \
  --profile <profile>
```

**Step 2: Break down by service**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-1m +%Y-%m-01),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=SERVICE \
  --output json \
  --profile <profile>
```

**Step 3: Identify top cost drivers** — parse JSON output, sort by cost descending, drill into top services.

---

### 4. EC2 Cost & Utilization Analysis

**EC2 costs for last 30 days (by instance type):**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=INSTANCE_TYPE \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Elastic Compute Cloud - Compute"]}}' \
  --output json \
  --profile <profile>
```

**Identify idle EC2 instances (check CPU over 7 days):**

```bash
# List running instances
aws ec2 describe-instances \
  --filters "Name=instance-state-name,Values=running" \
  --query 'Reservations[*].Instances[*].[InstanceId,InstanceType,LaunchTime,Tags[?Key==`Name`].Value|[0]]' \
  --output table \
  --profile <profile>

# Check CPU utilization per instance
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

**Recommendation:** Instances with <5% avg CPU and no significant network I/O are candidates for shutdown or right-sizing.

---

### 5. RDS Cost & Utilization Analysis

**RDS costs for last 30 days:**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics "UnblendedCost" \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Relational Database Service"]}}' \
  --output json \
  --profile <profile>
```

**List RDS instances and check connections:**

```bash
aws rds describe-db-instances \
  --query 'DBInstances[*].[DBInstanceIdentifier,DBInstanceClass,Engine,MultiAZ,DBInstanceStatus]' \
  --output table \
  --profile <profile>

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

**Optimization opportunities:**
- Dev/test databases running 24/7 → add to scheduler
- Multi-AZ in non-production → consider single-AZ
- Over-provisioned instances with low CPU/connections → downsize

---

### 6. EBS Volume Cost Analysis

**Identify unattached EBS volumes (100% waste):**

```bash
aws ec2 describe-volumes \
  --filters "Name=status,Values=available" \
  --query 'Volumes[*].[VolumeId,Size,VolumeType,CreateTime,AvailabilityZone]' \
  --output table \
  --profile <profile>
```

**Estimate savings:** `Volume_Size_GB × $0.08/GB/month` (approximate gp3 cost).

---

### 7. Reserved Instance & Savings Plan Coverage Analysis

**Check current Savings Plan coverage:**

```bash
aws ce get-savings-plans-coverage \
  --time-period Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --output json \
  --profile <profile>
```

**Check RI coverage:**

```bash
aws ce get-reservation-coverage \
  --time-period Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --output json \
  --profile <profile>
```

**Identify on-demand spend eligible for commitment:**
- Look for stable compute (consistent CPU usage, multi-week patterns)
- Recommend Compute Savings Plans for flexibility across EC2/Fargate/Lambda
- Conservative coverage recommendation: 70-80% of stable baseline (avoid over-commitment)

---

### 8. Budget Variance & Forecasting

**Compare current month to last month (AmortizedCost for RI/SP amortization):**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-2m +%Y-%m-01),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "AmortizedCost" \
  --group-by Type=DIMENSION,Key=SERVICE \
  --output json \
  --profile <profile>
```

**Forecasting approach:**
1. Pull last 3-6 months of monthly costs
2. Calculate month-over-month growth rate
3. Project: "Based on X% MoM growth, next month projected spend is $Y"
4. Identify which services are driving growth

---

### 9. Anomaly Detection

**Monitor for cost spikes (month-over-month):**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-2m +%Y-%m-01),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=SERVICE \
  --output json \
  --profile <profile>
```

**Flag:**
- Services with >30% month-over-month cost increase
- New services that appeared without prior cost history
- Cost spikes on specific days (check daily granularity)

---

### 10. Scheduler ROI Calculation

**Calculate potential savings from resource scheduling:**

1. Identify scheduled resources (query DynamoDB scheduler table if available)
2. Estimate current hourly cost per resource
3. Calculate runtime reduction: `(168 hrs/week − scheduled_hrs/week) / 168 = savings_pct`
4. Monthly savings: `hourly_cost × hours_saved × 4.33 weeks/month`

**Common example:**
- Development environment: 8 AM–6 PM Mon–Fri = 50 hrs/week → 70% savings vs 24/7

---

### 11. Multi-Account Cost Analysis

When analyzing costs across multiple accounts:
1. Call `get_aws_credentials` for each account
2. Run cost queries per account
3. Aggregate totals and compare
4. Format clearly:

```
Account: Production (123456789012)
- Total: $5,234/month
- Top services: EC2 ($2,100), RDS ($1,800), S3 ($500)
- Savings opportunity: $1,470/month (28%)

Account: Staging (987654321098)
- Total: $2,456/month
- Savings opportunity: $1,840/month (75%) — schedule resources!
```

---

### 12. Cost Optimization Report Template

When generating a report, structure as:

1. **Executive Summary** — total monthly cost, potential monthly savings, savings percentage
2. **Top Cost Drivers** — service breakdown, instance counts and types
3. **Quick Wins** (easy, high-impact)
   - Unattached EBS volumes → delete
   - Stopped instances with persistent EBS → terminate or snapshot+delete
   - Idle resources → add to scheduler
4. **Strategic Optimizations** (requires planning)
   - Right-sizing recommendations with specific instance IDs
   - RI/SP commitment opportunities with coverage gaps
   - Architecture changes for long-term savings
5. **Scheduler Impact** — current scheduled resources + estimated savings + additional candidates

---

## Best Practices

- **Always specify time ranges carefully** — do not exceed 14 months lookback
- **Keep all analysis data in memory** — render the complete report directly in your response, do NOT use write_file or write_file_to_s3 for reports
- **Calculate ROI** — show dollar impact, not just percentages
- **Prioritize quick wins** — sort recommendations by effort vs impact matrix
- **Account for growth** — consider future capacity needs before recommending downsizing
- **Emphasize tagging** — accurate cost allocation requires consistent `Environment`, `Owner`, `CostCenter`, `Application` tags
- **Unit economics** — where possible, relate cost to business value (cost per user, cost per transaction)

## Example Workflow

User: "Analyze EC2 costs for the last 3 months and find savings opportunities"

1. Get credentials for the target account
2. Get overall account cost for last 90 days
3. Filter by EC2 service, break down by instance type
4. List all running EC2 instances with names/tags
5. Check CPU and network utilization for top-cost instances (last 7 days)
6. Identify idle instances (<5% avg CPU)
7. Check RI/SP coverage for EC2
8. Calculate savings from stopping idle instances + RI commitment
9. Write complete report to S3 with specific instance IDs and dollar savings
