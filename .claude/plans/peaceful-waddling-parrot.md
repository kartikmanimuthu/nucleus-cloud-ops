# Inventory Management: Data Write Validation + S3 Tables Integration

## Context

The discovery lambda (`lambda/discovery/`) writes inventory data to 3 destinations:
1. **DynamoDB** — `INVENTORY_TABLE` (resources) + `APP_TABLE` (sync status/accounts)
2. **S3** — raw JSON per account/region/service + merged JSON across all accounts
3. **S3 Tables (Apache Iceberg)** — **currently a stub** in legacy `discovery.py`, NOT wired into the active code path (`src/main.py` / `src/data_processor.py`)

The CDK stack already defines the S3 Tables bucket (`TableBucket`) and passes `S3_TABLE_BUCKET_ARN` + `S3_TABLE_NAMESPACE=nucleus` to the ECS discovery task — but the write code is missing from the active source.

**Goal:** Implement the S3 Tables write in the active code path, test all 3 destinations locally, and validate data in AWS.

---

## AWS Profile & Resource Names

- **AWS Profile:** `STX-CLOUD-PLATFORM-ADMIN`
- Resource names are derived from CDK `APP_NAME` (default: `nucleus-app`). Retrieve actual values:

```bash
export AWS_PROFILE=STX-CLOUD-PLATFORM-ADMIN
aws cloudformation describe-stacks \
  --stack-name ComputeStack \
  --query 'Stacks[0].Outputs[?OutputKey==`InventoryTableName` || OutputKey==`InventoryBucketName`]'
```

Expected names (replace `<ACCOUNT>` and `<REGION>` with actuals):
- `APP_TABLE_NAME` = `nucleus-app-app-table`
- `INVENTORY_TABLE_NAME` = `nucleus-app-inventory-table`
- `INVENTORY_BUCKET` = `nucleus-app-inventory-<ACCOUNT>-<REGION>`
- `S3_TABLE_BUCKET_ARN` = from CDK output (ARN of S3 Tables bucket)

---

## Critical Files

| File | Change |
|------|--------|
| `lambda/discovery/src/data_processor.py` | Add `save_to_s3_tables()` + wire into `process_and_store_resources()` |
| `lambda/discovery/src/main.py` | Pass `S3_TABLE_BUCKET_ARN` / `S3_TABLE_NAMESPACE` env vars to `process_and_store_resources()` |
| `lambda/discovery/local_runner.py` | Add `--s3-table-bucket-arn` and `--s3-table-namespace` CLI args |

Reference (existing stub to port): `lambda/discovery/discovery.py` lines 343–407

---

## Implementation Steps

### Step 1: Add `save_to_s3_tables()` to `src/data_processor.py`

Add after the existing `store_merged_to_s3()` function (after line 295):

```python
def save_to_s3_tables(
    resources: List[Dict[str, Any]],
    s3_table_bucket_arn: str,
    s3_table_namespace: str = 'default',
    aws_region: str = 'us-east-1'
) -> int:
    """
    Write resources to AWS S3 Tables (Apache Iceberg) using PyIceberg REST catalog.

    Returns number of records written, or 0 on failure/skip.
    """
    if not s3_table_bucket_arn or not resources:
        print("  Skipping S3 Tables write: no bucket ARN or no resources")
        return 0

    try:
        import pandas as pd
        import pyarrow as pa
        from pyiceberg.catalog import load_catalog

        print(f"  Writing {len(resources)} resources to S3 Tables ({s3_table_bucket_arn})...")

        # AWS S3 Tables uses the Iceberg REST catalog endpoint
        catalog = load_catalog(
            "s3tables",
            **{
                "type": "rest",
                "uri": f"https://s3tables.{aws_region}.amazonaws.com/iceberg",
                "rest.sigv4-enabled": "true",
                "rest.signing-name": "s3tables",
                "rest.signing-region": aws_region,
                "rest.resource-arn": s3_table_bucket_arn,
                "warehouse": s3_table_bucket_arn,
            }
        )

        table_name = f"{s3_table_namespace}.resources"

        rows = []
        now = datetime.now(timezone.utc)
        for res in resources:
            rows.append({
                'resourceId': str(res.get('resourceId', '')),
                'resourceType': str(res.get('resourceType', '')),
                'name': str(res.get('name', '')),
                'arn': str(res.get('resourceArn', res.get('arn', ''))),
                'region': str(res.get('region', '')),
                'accountId': str(res.get('accountId', '')),
                'state': str(res.get('state', '')),
                'tags': json.dumps(res.get('tags', {})),
                'lastSeenAt': now,
                'discoveryStatus': 'active',
            })

        df = pd.DataFrame(rows)
        arrow_table = pa.Table.from_pandas(df)

        try:
            table = catalog.load_table(table_name)
            table.append(arrow_table)
            print(f"  Appended {len(rows)} rows to existing S3 Table {table_name}")
        except Exception as e:
            print(f"  Table {table_name} not found or write failed: {e}")
            return 0

        return len(rows)

    except ImportError:
        print("  Skipping S3 Tables write: pyiceberg/pandas/pyarrow not installed")
        return 0
    except Exception as e:
        print(f"  ERROR writing to S3 Tables: {e}")
        return 0
```

### Step 2: Call `save_to_s3_tables()` from `process_and_store_resources()`

Extend the function signature (line 298–308) to accept two new optional params:
```python
def process_and_store_resources(
    dynamodb_client,
    s3_client,
    table_name: str,
    bucket_name: str,
    account_id: str,
    resources: List[Dict[str, Any]],
    raw_results: Dict[str, Dict[str, Any]] = None,
    tenant_id: str = 'default',
    scan_id: str = None,
    s3_table_bucket_arn: str = None,       # NEW
    s3_table_namespace: str = 'default',   # NEW
    aws_region: str = 'us-east-1',         # NEW
) -> int:
```

At the end of the function, after DynamoDB batch writes complete, add:
```python
# S3 Tables write (Iceberg)
if s3_table_bucket_arn:
    save_to_s3_tables(resources, s3_table_bucket_arn, s3_table_namespace, aws_region)
```

### Step 3: Wire env vars in `src/main.py`

In the section where `process_and_store_resources()` is called (around lines 79–104), read env vars and pass them:
```python
s3_table_bucket_arn = os.environ.get('S3_TABLE_BUCKET_ARN')
s3_table_namespace = os.environ.get('S3_TABLE_NAMESPACE', 'nucleus')
aws_region = os.environ.get('AWS_REGION', 'us-east-1')

count = process_and_store_resources(
    ...,
    s3_table_bucket_arn=s3_table_bucket_arn,
    s3_table_namespace=s3_table_namespace,
    aws_region=aws_region,
)
```

### Step 4: Update `local_runner.py`

Add CLI arguments (after `--bucket` arg, ~line 53):
```python
parser.add_argument('--s3-table-bucket-arn', type=str,
    default=os.environ.get('S3_TABLE_BUCKET_ARN'),
    help='S3 Tables bucket ARN (for Iceberg writes)')
parser.add_argument('--s3-table-namespace', type=str,
    default=os.environ.get('S3_TABLE_NAMESPACE', 'nucleus'),
    help='S3 Tables namespace (default: nucleus)')
```

Pass to `process_and_store_resources()` call (~line 186):
```python
count = process_and_store_resources(
    dynamodb, s3, args.inventory_table, args.bucket, target_acc_id,
    resources, raw_results,
    s3_table_bucket_arn=args.s3_table_bucket_arn,
    s3_table_namespace=args.s3_table_namespace,
    aws_region=boto3.session.Session().region_name or 'us-east-1',
)
```

---

## Local Test Procedure

```bash
# 1. Set AWS profile
export AWS_PROFILE=STX-CLOUD-PLATFORM-ADMIN

# 2. Navigate and install deps
cd /Users/kartik/Documents/git-repo/nucleus-cloud-ops/.claude/worktrees/inventory-mgm-refacotoring/lambda/discovery
pip install -r requirements.txt

# 3. Get actual resource names from CDK outputs
aws cloudformation describe-stacks \
  --stack-name ComputeStack \
  --query 'Stacks[0].Outputs' \
  --output table

# 4. Run direct-mode scan (uses current credentials, no cross-account)
python local_runner.py \
  --regions ap-south-1 \
  --inventory-table nucleus-app-inventory-table \
  --app-table nucleus-app-app-table \
  --bucket nucleus-app-inventory-<ACCOUNT>-ap-south-1 \
  --s3-table-bucket-arn <S3_TABLE_BUCKET_ARN> \
  --s3-table-namespace nucleus \
  --verbose
```

---

## Validation Queries (All 3 Destinations)

### 1. DynamoDB — Inventory Table
```bash
aws dynamodb query \
  --table-name nucleus-app-inventory-table \
  --index-name GSI1 \
  --key-condition-expression "gsi1pk = :v" \
  --expression-attribute-values '{":v":{"S":"TYPE#INVENTORY"}}' \
  --limit 5 \
  --profile STX-CLOUD-PLATFORM-ADMIN
```
**Expected:** Items with `resourceId`, `resourceType`, `name`, `region`, `state`, `accountId` fields.

### 2. DynamoDB — Sync Status in APP Table
```bash
aws dynamodb query \
  --table-name nucleus-app-app-table \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values '{":pk":{"S":"SYNC#INVENTORY"}}' \
  --scan-index-forward false \
  --limit 3 \
  --profile STX-CLOUD-PLATFORM-ADMIN
```
**Expected:** Latest scan record with `totalResources`, `accountsSynced`, `syncedAt`, `status=completed`.

### 3. S3 — Raw JSON
```bash
aws s3 ls s3://nucleus-app-inventory-<ACCOUNT>-ap-south-1/raw/ \
  --recursive --human-readable \
  --profile STX-CLOUD-PLATFORM-ADMIN | head -20
```
**Expected:** Files at `raw/<YYYY-MM-DDTHH-MM>/<account>/<region>/<service-function>.json`.

### 4. S3 — Merged JSON
```bash
aws s3 ls s3://nucleus-app-inventory-<ACCOUNT>-ap-south-1/merged/ \
  --recursive --human-readable \
  --profile STX-CLOUD-PLATFORM-ADMIN | head -20
```
**Expected:** Files at `merged/<YYYY-MM-DDTHH-MM>/<service-function>.json`.

### 5. S3 Tables — Iceberg
```python
# validate_s3_tables.py — run after local test
import boto3, os
os.environ['AWS_PROFILE'] = 'STX-CLOUD-PLATFORM-ADMIN'

from pyiceberg.catalog import load_catalog
region = 'ap-south-1'
bucket_arn = '<S3_TABLE_BUCKET_ARN>'

catalog = load_catalog("s3tables", **{
    "type": "rest",
    "uri": f"https://s3tables.{region}.amazonaws.com/iceberg",
    "rest.sigv4-enabled": "true",
    "rest.signing-name": "s3tables",
    "rest.signing-region": region,
    "rest.resource-arn": bucket_arn,
    "warehouse": bucket_arn,
})

table = catalog.load_table("nucleus.resources")
df = table.scan(limit=5).to_pandas()
print(df)
```
**Expected:** DataFrame with 5 rows containing `resourceId`, `resourceType`, `name`, etc.

---

## Notes

- `save_to_s3_tables()` is **non-fatal** — errors are logged but do not stop DynamoDB/S3 writes.
- The existing `discovery.py` stub used `type: glue` — the correct approach for AWS S3 Tables (the new service) is `type: rest` with the `s3tables` endpoint. The Glue approach is for Glue-managed Iceberg tables, not AWS S3 Tables.
- `pyiceberg[s3fs,glue]` in `requirements.txt` is sufficient; no additional package needed for REST catalog.
- The S3 Tables bucket must have the `nucleus` namespace pre-created. CDK does this via `CfnTableBucket` + `CfnNamespace` resources.
