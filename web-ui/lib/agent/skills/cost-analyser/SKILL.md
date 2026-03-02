---
name: Cost Analyser
description: Query AWS Cost Explorer and billing data to identify spending trends, key cost movers, anomalies, and forecasts without deep resource-level analysis.
tier: read-only
date: 2026-03-01
---

# Cost Analyser

## Overview

This skill provides **high-level financial analysis** of AWS spending. It focuses on trends, patterns, key movers, and anomalies using Cost Explorer and billing data. Unlike the Cost Optimizer skill, it does NOT drill into individual resources.

> **READ-ONLY skill** — analyzes billing data and provides insights only.

## Core Capabilities

- Query Cost Explorer for spending trends
- Identify month-over-month cost changes
- Detect cost anomalies and spikes
- Analyze spending by service, account, region, or tag
- Forecast future costs based on historical trends
- Compare current vs previous periods
- Identify top cost movers (services with largest increases)
- Budget variance analysis

## Workflow

### 1. Overall Cost Trends

**Get last 6 months of costs:**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-6m +%Y-%m-01),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --output json \
  --profile <profile>
```

**Calculate:**
- Total spend per month
- Month-over-month growth rate
- Average monthly spend
- Trend direction (increasing/decreasing/stable)

### 2. Service-Level Breakdown

**Current month by service:**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date +%Y-%m-01),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=SERVICE \
  --output json \
  --profile <profile>
```

**Last month by service:**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-1m +%Y-%m-01),End=$(date -v-1m +%Y-%m-01 -v+1m -v-1d +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=SERVICE \
  --output json \
  --profile <profile>
```

**Identify top 10 services** and calculate change percentage.

### 3. Key Cost Movers

**Compare last 2 months to identify movers:**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-2m +%Y-%m-01),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=SERVICE \
  --output json \
  --profile <profile>
```

**Calculate for each service:**
- Absolute change: `current_month - previous_month`
- Percentage change: `(change / previous_month) × 100`
- Sort by absolute change descending

**Report format:**
```
Top Cost Movers (Month-over-Month):
1. Amazon EC2: +$1,234 (+23%) - $6,543 → $7,777
2. Amazon RDS: +$456 (+15%) - $3,040 → $3,496
3. AWS Lambda: -$123 (-8%) - $1,538 → $1,415
```

### 4. Daily Cost Trends

**Last 30 days daily breakdown:**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics "UnblendedCost" \
  --output json \
  --profile <profile>
```

**Identify:**
- Average daily spend
- Peak spending days
- Unusual spikes (>20% above average)

### 5. Cost by Region

**Current month by region:**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date +%Y-%m-01),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=REGION \
  --output json \
  --profile <profile>
```

**Use case:** Identify if costs are concentrated in specific regions.

### 6. Cost by Linked Account (Multi-Account)

**Current month by account:**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date +%Y-%m-01),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=LINKED_ACCOUNT \
  --output json \
  --profile <profile>
```

**Report:** Which accounts are driving costs?

### 7. Cost by Tag

**Analyze by Environment tag:**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date +%Y-%m-01),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=TAG,Key=Environment \
  --output json \
  --profile <profile>
```

**Common tags to analyze:**
- Environment (production, staging, dev)
- CostCenter
- Application
- Owner

### 8. Anomaly Detection

**Identify cost spikes:**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=SERVICE \
  --output json \
  --profile <profile>
```

**Flag anomalies:**
- Days with >30% increase vs 7-day average
- New services that appeared suddenly
- Services with unusual patterns

**AWS Cost Anomaly Detection API:**

```bash
aws ce get-anomalies \
  --date-interval Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --max-results 50 \
  --profile <profile>
```

### 9. Forecasting

**Get AWS cost forecast:**

```bash
aws ce get-cost-forecast \
  --time-period Start=$(date +%Y-%m-%d),End=$(date -v+1m +%Y-%m-01 -v-1d +%Y-%m-%d) \
  --metric UNBLENDED_COST \
  --granularity MONTHLY \
  --output json \
  --profile <profile>
```

**Manual forecast calculation:**
1. Get last 3 months of costs
2. Calculate average month-over-month growth rate
3. Project: `next_month = current_month × (1 + avg_growth_rate)`

### 10. Budget Variance Analysis

**Compare actual vs budget:**

```bash
aws budgets describe-budgets \
  --account-id <account-id> \
  --profile <profile>

aws budgets describe-budget \
  --account-id <account-id> \
  --budget-name <budget-name> \
  --profile <profile>
```

**Calculate:**
- Budget amount
- Actual spend to date
- Variance: `actual - budget`
- Percentage used: `(actual / budget) × 100`
- Projected end-of-month spend
- Projected variance

### 11. Reserved Instance & Savings Plan Coverage

**RI coverage:**

```bash
aws ce get-reservation-coverage \
  --time-period Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --output json \
  --profile <profile>
```

**Savings Plan coverage:**

```bash
aws ce get-savings-plans-coverage \
  --time-period Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --output json \
  --profile <profile>
```

**Report:**
- Coverage percentage
- On-demand spend (uncovered)
- Potential savings from increased coverage

### 12. Multi-Account Comparison

**When analyzing multiple accounts:**

1. Get credentials for each account
2. Run cost queries per account
3. Aggregate and compare

**Report format:**
```
Multi-Account Cost Summary (Current Month):

Production (123456789012): $12,345
- EC2: $5,678 (46%)
- RDS: $3,456 (28%)
- S3: $1,234 (10%)

Staging (987654321098): $4,567
- EC2: $2,345 (51%)
- RDS: $1,234 (27%)
- ECS: $567 (12%)

Development (555555555555): $2,890
- EC2: $1,456 (50%)
- RDS: $890 (31%)
- Lambda: $234 (8%)

Total: $19,802
```

## Output Format

Structure analysis report as:

```
# Cost Analysis Report
Account: <account-name> (<account-id>)
Period: <date-range>

## Executive Summary
- Current Month Spend: $X,XXX (as of <date>)
- Last Month Spend: $X,XXX
- Change: +$XXX (+X%)
- Projected End-of-Month: $X,XXX
- 6-Month Average: $X,XXX

## Spending Trends
- Month-over-month growth: +X%
- Quarter-over-quarter growth: +X%
- Trend: [Increasing/Decreasing/Stable]

## Top 5 Services (Current Month)
1. Amazon EC2: $X,XXX (XX%)
2. Amazon RDS: $X,XXX (XX%)
3. AWS Lambda: $X,XXX (XX%)
4. Amazon S3: $X,XXX (XX%)
5. Amazon CloudFront: $X,XXX (XX%)

## Key Cost Movers (vs Last Month)
1. Amazon EC2: +$XXX (+XX%)
2. AWS Lambda: +$XXX (+XX%)
3. Amazon RDS: -$XXX (-XX%)

## Anomalies Detected
- [Date]: EC2 spike of $XXX (+XX% vs average)
- [Date]: New service "AWS Glue" appeared ($XXX)

## Regional Distribution
- us-east-1: $X,XXX (XX%)
- ap-south-1: $X,XXX (XX%)
- eu-west-1: $X,XXX (XX%)

## Forecast
- Projected next month: $X,XXX
- Based on X% average growth rate
- Confidence: [High/Medium/Low]

## Recommendations
- Investigate EC2 cost increase (+23%)
- Review new AWS Glue usage
- Consider budget adjustment if trend continues
```

## Best Practices

- **Always specify time ranges** — do not exceed 14 months lookback
- **Use macOS date syntax** — `date -v-30d`, not `date -d '30 days ago'`
- **Calculate percentages** — absolute numbers + percentage change
- **Identify trends** — not just current state, but direction
- **Flag anomalies** — highlight unusual patterns
- **Provide context** — compare to previous periods
- **Focus on movers** — what changed, not just what's expensive
- **Keep it high-level** — do not drill into individual resources (that's Cost Optimizer's job)

## Constraints

- Cost Explorer data has 24-48 hour delay
- Historical data limited to 14 months
- Hourly granularity only available for last 14 days
- Tag-based analysis requires consistent tagging
- Forecasts are estimates based on historical trends

## When to Use Cost Optimizer Instead

If the user asks to:
- "Find idle EC2 instances"
- "Identify unattached EBS volumes"
- "Check which RDS databases are underutilized"
- "Analyze individual Lambda functions"

→ Recommend using the **Cost Optimizer** skill instead, as it performs resource-level analysis.

## Example Workflow

User: "Show me cost trends for the last 3 months and identify what's driving the increase"

1. Get credentials for target account
2. Query Cost Explorer for last 3 months (monthly granularity)
3. Calculate month-over-month changes
4. Get service breakdown for each month
5. Identify top 5 cost movers
6. Check for anomalies in daily data
7. Generate trend analysis report with key insights
8. Provide forecast for next month
