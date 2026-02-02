import uuid
import time
import json
import logging
from datetime import datetime, timezone
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

def create_audit_log(
    dynamodb_client,
    table_name: str,
    event_type: str,
    action: str,
    status: str,
    resource: str,
    details: str,
    metadata: Dict[str, Any] = None,
    user: str = 'system',
    user_type: str = 'system',
    source: str = 'discovery-lambda',
    severity: str = 'info',
    scan_id: str = None,
    correlation_id: str = None
) -> None:
    """
    Create an audit log entry in DynamoDB.
    """
    if not table_name:
        # Silently return or log warning, but don't crash
        print("WARNING: AUDIT_TABLE_NAME not set. Skipping audit log.")
        return

    try:
        audit_id = str(uuid.uuid4())
        timestamp = datetime.now(timezone.utc).isoformat()
        # TTL: 90 days
        expire_at = int(time.time()) + (90 * 24 * 60 * 60)
        
        # Prepare attributes
        item = {
            'pk': {'S': f'LOG#{audit_id}'},
            'sk': {'S': timestamp},
            'gsi1pk': {'S': 'TYPE#LOG'},
            'gsi1sk': {'S': timestamp},
            'gsi2pk': {'S': f'USER#{user}'},
            'gsi2sk': {'S': timestamp},
            'gsi3pk': {'S': f'EVENT#{event_type}'},
            'gsi3sk': {'S': timestamp},
            'expire_at': {'N': str(expire_at)},
            'id': {'S': audit_id},
            'timestamp': {'S': timestamp},
            'action': {'S': action},
            'status': {'S': status},
            'resource': {'S': resource},
            'details': {'S': details},
            'user': {'S': user},
            'userType': {'S': user_type},
            'source': {'S': source},
            'severity': {'S': severity},
        }

        if scan_id:
            item['scanId'] = {'S': scan_id}
        
        if correlation_id:
            item['correlationId'] = {'S': correlation_id}
        
        if metadata:
            # Store metadata as a Map if possible, or simplistically
            # Since boto3 low-level client requires explicit types, we'll try to map simple types
            # or just store as JSON string in a 'metadata_json' field or similar if the schema allows?
            # AuditService.ts spreads it. Let's try to do a basic Map for known strings.
            # Ideally we have a serializer. For now, let's just not fail.
            # We'll punt on complex metadata for now and just put it as M if simple, or skip.
            # Actually, let's rely on JSON stringifying it if it's complex, or skip.
            # Let's try to put it into 'metadata' attribute as Map.
            # Minimal serializer:
            m_item = {}
            for k, v in metadata.items():
                if isinstance(v, str):
                    m_item[k] = {'S': v}
                elif isinstance(v, bool):
                     m_item[k] = {'BOOL': v}
                elif isinstance(v, (int, float)):
                     m_item[k] = {'N': str(v)}
                # Ignore complex types for now to avoid errors
            
            if m_item:
                item['metadata'] = {'M': m_item}

        dynamodb_client.put_item(
            TableName=table_name,
            Item=item
        )
        print(f"Audit log created: {audit_id} ({event_type})")

    except Exception as e:
        print(f"ERROR: Failed to create audit log: {e}")
