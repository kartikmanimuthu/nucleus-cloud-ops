"""
PostgreSQL writer for discovery Lambda.
Writes inventory resources to the inventory_resources table using psycopg2.
Controlled by USE_PG_INVENTORY env var (dual-write alongside DynamoDB).

Column names match the Prisma schema (camelCase, no @map on individual fields):
  tenantId, accountId, region, resourceType, resourceId, name, status,
  tags (JSONB), metadata (JSONB), discoveredAt, updatedAt
"""
import os
import json
import logging
import uuid
from datetime import datetime, timezone, date
from decimal import Decimal
from typing import List, Dict, Any


class _SafeEncoder(json.JSONEncoder):
    """Handles datetime, date, and Decimal objects from AWS API responses."""
    def default(self, o):
        if isinstance(o, (datetime, date)):
            return o.isoformat()
        if isinstance(o, Decimal):
            return float(o)
        return super().default(o)

logger = logging.getLogger(__name__)


def is_pg_enabled() -> bool:
    """Return True if USE_PG_INVENTORY env var is set to 'true'."""
    return os.environ.get('USE_PG_INVENTORY', 'false').lower() == 'true'


def get_connection():
    """Create a psycopg2 connection from DATABASE_URL."""
    import psycopg2
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise ValueError(
            "DATABASE_URL environment variable is required for PostgreSQL writes"
        )
    return psycopg2.connect(database_url)


def write_resources_to_pg(
    resources: List[Dict[str, Any]],
    tenant_id: str,
    account_id: str,
    batch_size: int = 500
) -> int:
    """
    Upsert discovered resources to PostgreSQL inventory_resources table.

    Uses ON CONFLICT ("tenantId", "accountId", "resourceType", "resourceId") DO UPDATE
    to handle re-discovery of existing resources.

    Column names use camelCase to match Prisma schema field names (no @map on columns).
    Batched in chunks of batch_size for memory efficiency.

    Returns count of upserted records.
    """
    if not resources:
        return 0

    conn = get_connection()
    total = 0
    # Deduplicate entire list on conflict key before batching
    seen: dict = {}
    for r in resources:
        if not isinstance(r, dict):
            continue
        key = (
            r.get('resourceType', r.get('resource_type', '')),
            r.get('resourceId', r.get('resource_id', '')),
        )
        seen[key] = r
    deduped = list(seen.values())
    try:
        with conn.cursor() as cur:
            for i in range(0, len(deduped), batch_size):
                batch = deduped[i:i + batch_size]
                values_placeholders = []
                params = []

                for r in batch:
                    resource_type = r.get('resourceType', r.get('resource_type', ''))
                    resource_id = r.get('resourceId', r.get('resource_id', ''))
                    region = r.get('region', '')
                    name = r.get('name', r.get('resourceName', None))
                    # Use 'state' field as status (matches DynamoDB schema)
                    status = r.get('status', r.get('state', None))
                    tags = json.dumps(r.get('tags', {}), cls=_SafeEncoder)
                    # Everything not in typed columns goes to metadata JSONB
                    metadata = json.dumps(r.get('metadata', r.get('details', {})), cls=_SafeEncoder)

                    values_placeholders.append(
                        "(%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, NOW(), NOW())"
                    )
                    params.extend([
                        str(uuid.uuid4()),
                        tenant_id, account_id, region, resource_type,
                        resource_id, name, status, tags, metadata,
                    ])

                if not values_placeholders:
                    continue

                sql = """
                    INSERT INTO inventory_resources
                        (id, "tenantId", "accountId", region, "resourceType", "resourceId",
                         name, status, tags, metadata, "discoveredAt", "updatedAt")
                    VALUES {placeholders}
                    ON CONFLICT ("tenantId", "accountId", "resourceType", "resourceId")
                    DO UPDATE SET
                        name = EXCLUDED.name,
                        status = EXCLUDED.status,
                        tags = EXCLUDED.tags,
                        metadata = EXCLUDED.metadata,
                        "updatedAt" = NOW()
                """.format(placeholders=', '.join(values_placeholders))

                cur.execute(sql, params)
                total += len(batch)
                logger.info(
                    "[pg_writer] Upserted batch %d: %d resources",
                    i // batch_size + 1,
                    len(batch),
                )

            conn.commit()
    except Exception as e:
        conn.rollback()
        logger.error("[pg_writer] Failed to write resources to PostgreSQL: %s", e)
        raise
    finally:
        conn.close()

    logger.info(
        "[pg_writer] Total upserted: %d resources for account %s",
        total,
        account_id,
    )
    return total
