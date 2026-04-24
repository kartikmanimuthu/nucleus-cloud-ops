# Local RDS Connection via SSM Tunnel

Connect to the cloud PostgreSQL (RDS) from your local machine using the bastion host over AWS SSM — no SSH keys or open inbound ports required.

---

## Prerequisites

- AWS CLI installed and configured
- `AWS_PROFILE=STX-CLOUD-PLATFORM` has SSM permissions
- Session Manager plugin installed:
  ```bash
  brew install --cask session-manager-plugin
  ```
- `psql` installed (optional, for CLI access):
  ```bash
  brew install libpq && brew link --force libpq
  ```

---

## Step 1 — Start the tunnel

Open a terminal and run:

```bash
bash infra/tunnel.sh
```

Or directly:

```bash
AWS_PROFILE=STX-CLOUD-PLATFORM aws ssm start-session \
  --target i-0495ea2b853ce6c8e \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["nucleus-cloud-ops-postgres.cxoucc8oef6b.ap-south-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}' \
  --region ap-south-1
```

You should see:
```
Port 5432 opened for sessionId ...
Waiting for connections...
```

**Keep this terminal open.** The tunnel closes when you exit it.

---

## Step 2 — Connect

### psql (CLI)

```bash
psql "postgresql://nucleus_admin:NmHq6LVdue1Wxho6ToDJy4fZ@localhost:5432/nucleus?sslmode=require"
```

### GUI tools (TablePlus / DBeaver / pgAdmin)

| Field    | Value                                      |
|----------|--------------------------------------------|
| Host     | `localhost`                                |
| Port     | `5432`                                     |
| Database | `nucleus`                                  |
| Username | `nucleus_admin`                            |
| Password | `NmHq6LVdue1Wxho6ToDJy4fZ`                |
| SSL mode | `require`                                  |

### Local app / migration scripts

```bash
DATABASE_URL="postgresql://nucleus_admin:NmHq6LVdue1Wxho6ToDJy4fZ@localhost:5432/nucleus?sslmode=require&uselibpqcompat=true"
```

---

## Step 3 — Run migrations (if needed)

With the tunnel open:

```bash
# Prisma schema migrations
DATABASE_URL="postgresql://nucleus_admin:NmHq6LVdue1Wxho6ToDJy4fZ@localhost:5432/nucleus?sslmode=require&uselibpqcompat=true" \
  node_modules/.bin/prisma migrate deploy

# Data migration — accounts + schedules from DynamoDB
AWS_PROFILE=STX-CLOUD-PLATFORM \
APP_TABLE_NAME=nucleus-app-app-table \
AWS_REGION=ap-south-1 \
DATABASE_URL="postgresql://nucleus_admin:NmHq6LVdue1Wxho6ToDJy4fZ@localhost:5432/nucleus?sslmode=require&uselibpqcompat=true" \
  node_modules/.bin/tsx scripts/migrate-accounts-schedules-cloud.ts
```

---

## Reference

| Resource         | Value                                                                 |
|------------------|-----------------------------------------------------------------------|
| Bastion instance | `i-0495ea2b853ce6c8e` (private subnet, SSM only)                     |
| RDS endpoint     | `nucleus-cloud-ops-postgres.cxoucc8oef6b.ap-south-1.rds.amazonaws.com` |
| RDS port         | `5432`                                                                |
| Database         | `nucleus`                                                             |
| AWS region       | `ap-south-1`                                                          |
| AWS profile      | `STX-CLOUD-PLATFORM`                                                  |
