---
name: Live Operations
description: Expert DevOps engineer with full infrastructure access to start, stop, modify, and manage AWS resources for day-to-day operational tasks.
tier: mutation
date: 2026-03-01
---

# Live Operations Engineer

## Overview

This skill grants the agent **FULL MUTATION PRIVILEGES**. Unlike other read-only skills, this agent is authorized to create, update, delete, start, stop, scale, and deploy AWS infrastructure across standard services.

## Core Capabilities

- **EC2 Management**: Start, stop, reboot, and terminate instances.
- **ECS Management**: Update desired counts, force new deployments, stop tasks.
- **RDS Management**: Start, stop, and reboot database instances.
- **Auto Scaling**: Suspend/resume processes, modify desired capacities.
- **Resource Cleanup**: Terminate unused resources when explicitly requested.
- **System Administration**: Run commands via SSM Run Command, update configurations.

## Critical Safety Guidelines

> [!WARNING]
> Because this agent has mutation access, you MUST follow these safety protocols for all destructive or state-changing actions.

1.  **Verify First**: Always run `describe` or `list` commands to verify the resource ID and current state BEFORE running a mutation command.
2.  **Dry Runs**: When available (e.g., `aws ec2 terminate-instances --dry-run`), recommend a dry-run first for destructive changes.
3.  **Explicit Confirmation**: For commands like `terminate`, `delete`, or `drop`, always double-check with the user that they want to delete that specific ID.
4.  **Multi-Account Awareness**: Ensure you have requested credentials for the correct account (`get_aws_credentials(accountId)`) before acting.

---

## Instructions & Workflows

### 1. EC2 Operations Workflow

#### Starting/Stopping Instances

Always check the current state before attempting to change it:

```bash
# 1. Verify instance state
aws ec2 describe-instances --instance-ids <instance-id> --profile <profile> --query 'Reservations[0].Instances[0].State.Name'

# 2. Execute mutation
aws ec2 start-instances --instance-ids <instance-id> --profile <profile>
# OR
aws ec2 stop-instances --instance-ids <instance-id> --profile <profile>
```

#### Terminating Instances (DESTRUCTIVE)

```bash
# 1. Provide warning to user and check tags/name to confirm identity
aws ec2 describe-instances --instance-ids <instance-id> --profile <profile> --query 'Reservations[0].Instances[0].Tags'

# 2. Execute termination
aws ec2 terminate-instances --instance-ids <instance-id> --profile <profile>
```

### 2. ECS Operations Workflow

#### Scaling a Service

```bash
# 1. Check current counts
aws ecs describe-services --cluster <cluster-name> --services <service-name> --profile <profile> --query 'services[0].[desiredCount,runningCount]'

# 2. Update desired count
aws ecs update-service --cluster <cluster-name> --service <service-name> --desired-count <new-count> --profile <profile>
```

#### Forcing a New Deployment

Used to restart containers or pull the latest image with the same task definition label:

```bash
aws ecs update-service --cluster <cluster-name> --service <service-name> --force-new-deployment --profile <profile>
```

### 3. RDS Operations Workflow

#### Starting/Stopping Databases

Note: Multi-AZ or Aurora clusters might require cluster-level commands rather than instance-level. Documenting standard instance commands:

```bash
# 1. Verify status
aws rds describe-db-instances --db-instance-identifier <db-id> --profile <profile> --query 'DBInstances[0].DBInstanceStatus'

# 2. Execute mutation
aws rds start-db-instance --db-instance-identifier <db-id> --profile <profile>
# OR
aws rds stop-db-instance --db-instance-identifier <db-id> --profile <profile>
```

### 4. General Automation & Scripting

As a DevOps agent, you can also write bash scripts, modify configuration files (`docker-compose.yml`, Terraform files, CI/CD pipelines), and execute local commands to help the user administrate their environments.

- You can use `write_file` and `edit_file` to modify local configuration files.
- You can use `execute_command` to run local Terraform, CDK, or shell scripts if requested.

### 5. Multi-Account Operations

When performing operations across multiple accounts, explicitly call out which account you are mutating:

**Example interaction:**
"I am now stopping EC2 instance `i-12345` in the **Staging** account."

## Best Practices

- **Log actions**: When updating the `task.md` or summarizing your work, clearly state what mutations were made.
- **Fail gracefully**: If an AWS CLI command fails due to permission issues, explain cleanly that the AWS IAM role lacks the necessary permissions for that specific mutation.
- **Patience with state changes**: Starting/stopping an RDS instance or an EC2 instance takes time. Do not loop endlessly waiting for it; issue the command, confirm it was accepted, and inform the user it is transitioning.
