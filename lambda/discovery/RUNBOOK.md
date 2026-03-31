# Discovery Lambda — Local Runbook

## Prerequisites

- Docker running with `nucleus-postgres` container (`docker compose up -d`)
- AWS SSO logged in: `aws sso login --profile PLATFORM-ADMIN`
- Python deps installed: `pip install -r requirements.txt`

---

## Truncate inventory_resources table

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus \
  -c "TRUNCATE TABLE inventory_resources;"
```

---

## Run discovery locally

### Single account (current credentials, direct mode)

```bash
cd lambda/discovery && \
  AWS_PROFILE=PLATFORM-ADMIN \
  USE_PG_INVENTORY=true \
  DATABASE_URL="postgresql://nucleus:nucleus_dev@localhost:5432/nucleus" \
  APP_TABLE_NAME=nucleus-app-app-table \
  INVENTORY_TABLE_NAME=nucleus-app-inventory-table \
  python3 local_runner.py \
    --regions ap-south-1 \
    --inventory-table nucleus-app-inventory-table \
    --bucket nucleus-app-inventory-970547372609-ap-south-1
```

### All active accounts (cross-account via discovery task role)

The cross-account `NucleusAccess-*` roles require the `nucleus-app-discovery-task-role`
as the caller. This wrapper assumes that role first, then runs the scan.

```bash
cd lambda/discovery && \
AWS_PROFILE=PLATFORM-ADMIN python3 - <<'EOF'
import boto3, os, subprocess, sys

# Step 1: Assume discovery task role (has sts:AssumeRole on NucleusAccess-*)
sts = boto3.client('sts')
creds = sts.assume_role(
    RoleArn='arn:aws:iam::970547372609:role/nucleus-app-discovery-task-role',
    RoleSessionName='nucleus-local-discovery'
)['Credentials']
print("Assumed nucleus-app-discovery-task-role")

env = {
    **os.environ,
    'AWS_ACCESS_KEY_ID':     creds['AccessKeyId'],
    'AWS_SECRET_ACCESS_KEY': creds['SecretAccessKey'],
    'AWS_SESSION_TOKEN':     creds['SessionToken'],
    'AWS_DEFAULT_REGION':    'ap-south-1',
    'USE_PG_INVENTORY':      'true',
    'DATABASE_URL':          'postgresql://nucleus:nucleus_dev@localhost:5432/nucleus',
    'APP_TABLE_NAME':        'nucleus-app-app-table',
    'INVENTORY_TABLE_NAME':  'nucleus-app-inventory-table',
}
env.pop('AWS_PROFILE', None)

# Step 2: Run all-accounts scan
result = subprocess.run(
    [sys.executable, 'local_runner.py',
     '--all-accounts',
     '--app-table',        'nucleus-app-app-table',
     '--inventory-table',  'nucleus-app-inventory-table',
     '--bucket',           'nucleus-app-inventory-970547372609-ap-south-1',
    ],
    env=env, text=True
)
sys.exit(result.returncode)
EOF
```

### Single cross-account (by account ID)

```bash
cd lambda/discovery && \
AWS_PROFILE=PLATFORM-ADMIN python3 - <<'EOF'
import boto3, os, subprocess, sys

ACCOUNT_ID = "042428207891"   # <-- change this

sts = boto3.client('sts')
creds = sts.assume_role(
    RoleArn='arn:aws:iam::970547372609:role/nucleus-app-discovery-task-role',
    RoleSessionName='nucleus-local-discovery'
)['Credentials']

env = {
    **os.environ,
    'AWS_ACCESS_KEY_ID':     creds['AccessKeyId'],
    'AWS_SECRET_ACCESS_KEY': creds['SecretAccessKey'],
    'AWS_SESSION_TOKEN':     creds['SessionToken'],
    'AWS_DEFAULT_REGION':    'ap-south-1',
    'USE_PG_INVENTORY':      'true',
    'DATABASE_URL':          'postgresql://nucleus:nucleus_dev@localhost:5432/nucleus',
    'APP_TABLE_NAME':        'nucleus-app-app-table',
    'INVENTORY_TABLE_NAME':  'nucleus-app-inventory-table',
}
env.pop('AWS_PROFILE', None)

result = subprocess.run(
    [sys.executable, 'local_runner.py',
     '--account-id',       ACCOUNT_ID,
     '--app-table',        'nucleus-app-app-table',
     '--inventory-table',  'nucleus-app-inventory-table',
     '--bucket',           'nucleus-app-inventory-970547372609-ap-south-1',
    ],
    env=env, text=True
)
sys.exit(result.returncode)
EOF
```

---

## Verify data in PostgreSQL

```bash
# Row count + accounts
docker exec nucleus-postgres psql -U nucleus -d nucleus -c "
SELECT
  COUNT(*) as total_rows,
  COUNT(DISTINCT \"accountId\") as accounts,
  COUNT(DISTINCT \"resourceType\") as resource_types,
  MAX(\"updatedAt\") as last_updated
FROM inventory_resources;
"

# Breakdown by resource type
docker exec nucleus-postgres psql -U nucleus -d nucleus -c "
SELECT \"resourceType\", COUNT(*) as count
FROM inventory_resources
GROUP BY \"resourceType\"
ORDER BY count DESC;
"
```

---

## Notes

- `USE_PG_INVENTORY=true` — writes exclusively to PostgreSQL, skips DynamoDB
- `DATABASE_URL` — points to local Docker postgres (`nucleus-postgres` container)
- `ERROR saving sync status` — harmless; the task role lacks `dynamodb:PutItem` locally
- Account `123456778901` returns 0 resources (test/placeholder account)
- The `nucleus-app-discovery-task-role` trust policy was updated to allow the
  `AWSReservedSSO_stx-devops-super-admin-kt4t_b59b88c38dd16578` SSO role for local dev
