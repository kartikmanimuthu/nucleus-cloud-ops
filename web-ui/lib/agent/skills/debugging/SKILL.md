---
name: Debugging
description: Expert in troubleshooting AWS services (EC2, ECS, RDS, ALB) and log analysis.
---

# Production Debugging Engineer

## Overview

This skill provides systematic approaches to troubleshoot and diagnose production issues across AWS infrastructure, focusing on common services like EC2, ECS, RDS, and Application Load Balancers.

## Core Capabilities

- EC2 instance health and connectivity diagnosis
- ECS service and task troubleshooting
- RDS database connection and performance issues
- ALB health check analysis and routing problems
- CloudWatch logs and metrics analysis
- Systems Manager (SSM) session access

## Instructions

### 1. Initial Triage

When a user reports an issue, start with these questions:
- Which AWS service is affected? (EC2, ECS, RDS, ALB, etc.)
- What symptoms are observed? (service down, slow responses, errors)
- When did the issue start?
- Any recent changes to the infrastructure?

### 2. EC2 Troubleshooting Workflow

**Check Instance Status:**
```bash
aws ec2 describe-instance-status --instance-ids <instance-id> --profile <profile>
aws ec2 describe-instances --instance-ids <instance-id> --profile <profile> --query 'Reservations[0].Instances[0].[State.Name,StateReason.Message]'
```

**Verify Security Groups:**
```bash
aws ec2 describe-security-groups --group-ids <sg-id> --profile <profile>
```

**Check SSM Access:**
```bash
aws ssm describe-instance-information --filters "Key=InstanceIds,Values=<instance-id>" --profile <profile>
```

**If SSM is available, diagnose:**
- Disk space: `df -h`
- Memory: `free -m`
- CPU: `top -bn1 | head -20`
- Network connectivity: `ping -c 4 8.8.8.8`

### 3. ECS Service Troubleshooting Workflow

**Check Service Status:**
```bash
aws ecs describe-services --cluster <cluster-name> --services <service-name> --profile <profile>
```

**Check Task Status:**
```bash
aws ecs describe-tasks --cluster <cluster-name> --tasks <task-id> --profile <profile>
```

**Analyze Task Stopped Reasons:**
```bash
aws ecs describe-tasks --cluster <cluster-name> --tasks <task-id> --profile <profile> --query 'tasks[0].stoppedReason'
```

**Check CloudWatch Logs:**
```bash
aws logs tail /ecs/<service-name> --since 30m --follow --profile <profile>
```

**Common Issues:**
- **Task failing health checks**: Check target group health in ALB
- **Tasks stuck in PENDING**: Check capacity, IAM roles, ENI limits
- **Tasks stopping immediately**: Check container logs for application errors

### 4. RDS Troubleshooting Workflow

**Check Database Status:**
```bash
aws rds describe-db-instances --db-instance-identifier <db-id> --profile <profile> --query 'DBInstances[0].[DBInstanceStatus,Endpoint.Address,Endpoint.Port]'
```

**Check Recent Events:**
```bash
aws rds describe-events --source-identifier <db-id> --source-type db-instance --duration 1440 --profile <profile>
```

**Verify Security Groups:**
```bash
aws rds describe-db-instances --db-instance-identifier <db-id> --profile <profile> --query 'DBInstances[0].VpcSecurityGroups'
```

**Check Connectivity from EC2:**
- Connect via SSM to an EC2 in same VPC
- Test: `telnet <rds-endpoint> 3306`  (or appropriate port)

**Common Issues:**
- **Connection timeouts**: Check security groups, NACLs, route tables
- **Authentication failures**: Verify credentials, IAM authentication settings
- **High CPU/Memory**: Check CloudWatch metrics for resource exhaustion

### 5. ALB Troubleshooting Workflow

**Check ALB Status:**
```bash
aws elbv2 describe-load-balancers --names <alb-name> --profile <profile>
```

**Check Target Group Health:**
```bash
aws elbv2 describe-target-health --target-group-arn <tg-arn> --profile <profile>
```

**Analyze Unhealthy Targets:**
- Check health check configuration
- Verify target instance/task is running
- Test health check endpoint directly

**Check ALB Metrics (Last Hour):**
```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name UnHealthyHostCount \
  --dimensions Name=LoadBalancer,Value=<alb-name> \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average \
  --profile <profile>
```

**Common Issues:**
- **502/503 errors**: Target unhealthy or not responding
- **504 errors**: Timeout - check application response time
- **Health check failures**: Verify path, timeout, and interval settings

### 6. CloudWatch Logs Analysis

**Search for errors in log group:**
```bash
aws logs filter-log-events \
  --log-group-name <log-group> \
  --filter-pattern "ERROR" \
  --start-time $(date -d '1 hour ago' +%s)000 \
  --profile <profile> \
  --max-items 50
```

**Tail logs in real-time:**
```bash
aws logs tail <log-group> --since 10m --follow --profile <profile>
```

### 7. Multi-Account Troubleshooting

When operating across multiple accounts:
1. Always call `get_aws_credentials` for each account
2. Use returned profile name with `--profile` flag
3. Clearly label which account each finding belongs to
4. Compare configurations across accounts if investigating cross-account issues

## Best Practices

- **Start broad, then narrow**: Begin with service-level checks, then drill into specifics
- **Check recent changes**: Always review recent deployments, config changes, or infrastructure updates
- **Use metrics**: CloudWatch metrics often reveal issues before logs
- **Document findings**: Clearly state what was checked, what was found, and what to investigate next
- **Read-only mode**: Remember you cannot make changes - only diagnose and recommend fixes

## Example Workflow

User: "My ALB is returning 503 errors"

1. Check ALB status and target groups
2. Check target health - identify unhealthy targets
3. If targets are ECS tasks: check task status, logs, and container health
4. If targets are EC2: check instance status, security groups, application logs
5. Check CloudWatch metrics for pattern (sporadic vs constant)
6. Provide diagnosis and recommended remediation steps
