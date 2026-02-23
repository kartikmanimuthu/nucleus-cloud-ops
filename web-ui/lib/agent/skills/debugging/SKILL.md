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
- **Systems Manager (SSM): interactive shell on EC2 via Session Manager, remote Run Command diagnostics**
- **SSM Parameter Store inspection for config/secret drift issues**

## Instructions

### 1. 🔒 READ-ONLY MODE & CONSTRAINTS

**CRITICAL:** You are a strictly READ-ONLY agent. 
- Your goal is to diagnose issues without affecting live systems.
- You MUST NOT restart services, reboot instances, or modify configurations. 
- You must rely entirely on `describe`, `list`, `get`, `logs`, and `tail` commands to investigate.

### 2. Initial Triage

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

> [!TIP]
> Always check SSM agent availability first. If SSM is unavailable, go straight to the **SSM Troubleshooting (Section 7)** workflow below before trying anything else.

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

---

### 7. 🔌 SSM — Agent Login & Remote Diagnostics Workflow

The Nucleus cross-account role includes the **NucleusAgentSSMPolicy**, which grants full SSM access. Use this to log into EC2 instances without SSH or a bastion host.

#### Step 1: Verify SSM Agent is Running on the Instance

```bash
# Check if instance is registered and reachable via SSM
aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=<instance-id>" \
  --profile <profile> \
  --query 'InstanceInformationList[0].[InstanceId,PingStatus,LastPingDateTime,AgentVersion,PlatformType,IPAddress]' \
  --output table
```

**PingStatus values:**
- `Online` → SSM agent is alive and connected to SSM endpoints
- `ConnectionLost` → Agent is installed but unreachable. Check:
  - VPC endpoint for SSM (`com.amazonaws.<region>.ssm`) if instance is in a private subnet
  - Instance role has `AmazonSSMManagedInstanceCore` policy attached
  - NAT Gateway or IGW for non-VPC-endpoint path
- Instance not listed → SSM agent not installed or IAM instance profile missing

```bash
# Check connection status directly
aws ssm get-connection-status \
  --target <instance-id> \
  --profile <profile>
```

#### Step 2: Start an Interactive Session (Session Manager)

> [!IMPORTANT]
> This opens a shell on the instance exactly like SSH. Use this for real-time investigation when you need to inspect logs, run commands interactively, or check the process tree.

```bash
# Start interactive shell session (requires AWS CLI Session Manager plugin)
aws ssm start-session \
  --target <instance-id> \
  --profile <profile>
```

**Prerequisites on the local machine:**
```bash
# Install Session Manager plugin (one-time setup)
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/mac/sessionmanager-bundle.zip" -o sm-plugin.zip
unzip sm-plugin.zip && sudo ./sessionmanager-bundle/install -i /usr/local/sessionmanagerplugin -b /usr/local/bin/session-manager-plugin
```

**Once inside the session — diagnostic commands:**
```bash
# Disk usage
df -hT

# Memory
free -mh
cat /proc/meminfo | grep -E 'MemTotal|MemFree|MemAvailable|Cached'

# CPU load
top -bn1 | head -25
mpstat 1 3

# Running processes (sorted by CPU)
ps aux --sort=-%cpu | head -20

# Network connections and listening ports
ss -tlnp
netstat -tlnp 2>/dev/null || ss -tlnp

# Test connectivity to a specific target (e.g., RDS or another VPC)
curl -v telnet://<target-host>:<port> --connect-timeout 5
nc -zv <target-host> <port>
ping -c 4 <target-ip>

# DNS resolution (for hybrid DNS troubleshooting)
dig <hostname>
nslookup <hostname>

# OS-level route table
ip route show
route -n

# Check application logs
journalctl -u <service-name> --since "30 min ago"
tail -f /var/log/app/*.log
ls -lht /var/log/ | head -20

# Security group / iptables rules on the OS
iptables -L -n -v
```

#### Step 3: Run Commands Non-Interactively via SSM Run Command

Use Run Command when you want to execute a diagnostic script across one or more instances **without opening an interactive session**.

```bash
# Run a single shell command on an instance
aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --targets "Key=instanceids,Values=<instance-id>" \
  --parameters 'commands=["df -hT","free -mh","ss -tlnp","ps aux --sort=-%cpu | head -20"]' \
  --profile <profile> \
  --query 'Command.CommandId' \
  --output text

# Poll for results (replace <command-id> with output from above)
aws ssm get-command-invocation \
  --command-id <command-id> \
  --instance-id <instance-id> \
  --profile <profile> \
  --query '[Status,StandardOutputContent,StandardErrorContent]'
```

**Common diagnostic Run Command payloads:**

```bash
# Disk, memory, CPU snapshot
aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --targets "Key=instanceids,Values=<instance-id>" \
  --parameters 'commands=["echo == DISK ==; df -hT; echo == MEMORY ==; free -mh; echo == CPU ==; top -bn1 | head -15; echo == NETWORK ==; ss -tlnp"]' \
  --profile <profile>

# Application log tail (last 100 lines)
aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --targets "Key=instanceids,Values=<instance-id>" \
  --parameters 'commands=["tail -100 /var/log/app/app.log 2>/dev/null || journalctl -u app --lines=100 --no-pager"]' \
  --profile <profile>

# Network connectivity test to a target (useful for RDS/Redis/internal service)
aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --targets "Key=instanceids,Values=<instance-id>" \
  --parameters 'commands=["nc -zv <target-host> <port> && echo REACHABLE || echo NOT REACHABLE"]' \
  --profile <profile>
```

#### Step 4: SSM Session for Port Forwarding (Access Private Endpoints Locally)

Use this to access a private RDS, Redis, or internal service on your local machine **through the EC2 instance as a jump box** — no SSH needed.

```bash
# Forward local port 5432 → RDS endpoint:5432 via EC2 jump box
aws ssm start-session \
  --target <ec2-instance-id> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<rds-endpoint>"],"portNumber":["5432"],"localPortNumber":["5432"]}' \
  --profile <profile>
```

#### Step 5: ECS Exec (For Container-Level Debugging)

For ECS Fargate or EC2 tasks, use ECS Exec (powered by SSM) to get a shell inside a running container:

```bash
# Enable ECS Exec on a service (DevOps skill required for this mutation)
# aws ecs update-service --cluster <cluster> --service <service> --enable-execute-command

# Execute interactive shell in a running ECS task
aws ecs execute-command \
  --cluster <cluster-name> \
  --task <task-id> \
  --container <container-name> \
  --interactive \
  --command "/bin/sh" \
  --profile <profile>
```

> [!NOTE]
> ECS Exec requires that the task's IAM role has `ssmmessages:CreateControlChannel`, `ssmmessages:CreateDataChannel`, `ssmmessages:OpenControlChannel`, and `ssmmessages:OpenDataChannel`. These are permissions on the **instance/task role**, not the Nucleus cross-account role.

#### Step 6: SSM Parameter Store — Config & Secret Inspection

Use this to check if application configuration or secrets have drifted from expected values:

```bash
# List all parameters in a path
aws ssm get-parameters-by-path \
  --path "/myapp/prod/" \
  --recursive \
  --with-decryption \
  --profile <profile> \
  --query 'Parameters[*].[Name,Value,Type,LastModifiedDate]' \
  --output table

# Get a single parameter
aws ssm get-parameter \
  --name "/myapp/prod/database_url" \
  --with-decryption \
  --profile <profile> \
  --query 'Parameter.[Name,Value,LastModifiedDate]'

# List all parameters (names only) in account
aws ssm describe-parameters \
  --profile <profile> \
  --query 'Parameters[*].[Name,Type,LastModifiedDate,Tier]' \
  --output table
```

#### Common SSM Failure Reasons & Fixes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Instance not in SSM list | No `AmazonSSMManagedInstanceCore` on instance role | Attach managed policy to EC2 instance profile |
| `PingStatus: ConnectionLost` (private subnet) | No SSM VPC Endpoints | Create VPC endpoints for `ssm`, `ssmmessages`, `ec2messages` |
| `AccessDenied` on `StartSession` | Nucleus role lacks `ssm:StartSession` | Verify `NucleusAgentSSMPolicy` is deployed via CF template |
| Session starts but immediately disconnects | SSM agent version too old | Update SSM agent: `sudo yum install -y amazon-ssm-agent` |
| ECS Exec fails | `enableExecuteCommand` not set on service | DevOps agent must run `aws ecs update-service --enable-execute-command` |


## Best Practices

- **Start broad, then narrow**: Begin with service-level checks, then drill into specifics
- **Check recent changes**: Always review recent deployments, config changes, or infrastructure updates
- **Use metrics**: CloudWatch metrics often reveal issues before logs
- **Document findings**: Clearly state what was checked, what was found, and what to investigate next
- **Read-only mode**: Remember you cannot make changes — only diagnose and recommend fixes
- **Prefer SSM over guessing**: When logs are inconclusive, use SSM Session Manager or Run Command to get ground truth from inside the instance
- **Port forwarding for private endpoints**: Use SSM port forwarding to reach private RDS/Redis without modifying security groups

## Example Workflow

User: "My ALB is returning 503 errors"

1. Check ALB status and target groups
2. Check target health - identify unhealthy targets
3. If targets are ECS tasks: check task status, logs, and container health
4. If targets are EC2: check instance status, security groups, application logs
5. Check CloudWatch metrics for pattern (sporadic vs constant)
6. Provide diagnosis and recommended remediation steps
