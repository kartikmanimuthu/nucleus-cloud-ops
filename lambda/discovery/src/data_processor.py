"""
Data Processor - Stores discovered resources in DynamoDB and S3.

Enhanced for dual persistence with organized S3 structure and 
optimized DynamoDB schema for web UI filtering.
"""
import json
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Set
from decimal import Decimal


class DateTimeEncoder(json.JSONEncoder):
    """Custom JSONEncoder that supports encoding datetime objects and Decimals."""
    def default(self, o):
        if isinstance(o, datetime):
            return o.isoformat()
        if isinstance(o, Decimal):
            return float(o)
        return super().default(o)


def generate_resource_arn(resource: Dict[str, Any], account_id: str) -> str:
    """Generate a resource ARN if not provided."""
    if resource.get('resourceArn'):
        return resource['resourceArn']
    
    # Construct a pseudo-ARN for resources without native ARN
    resource_type = resource.get('resourceType', 'unknown')
    resource_id = resource.get('resourceId', 'unknown')
    region = resource.get('region', 'unknown')
    service = resource.get('service', 'unknown')
    
    return f"arn:aws:{service}:{region}:{account_id}:{resource_type}/{resource_id}"


def store_raw_to_s3(
    s3_client,
    bucket_name: str,
    account_id: str,
    raw_results: Dict[str, Dict[str, Any]],
    timestamp: str
) -> Dict[str, str]:
    """
    Store raw scan results to S3 organized by account/region/service.
    
    Structure: raw/{timestamp}/{account_id}/{region}/{service-function}.json
    
    Args:
        s3_client: Boto3 S3 client
        bucket_name: S3 bucket name
        account_id: AWS account ID
        raw_results: Dict organized as {region: {service-function: data}}
        timestamp: ISO timestamp for folder organization
        
    Returns:
        Dict mapping region to S3 keys
    """
    s3_keys = {}
    date_folder = timestamp.replace(':', '-')[:16]  # YYYY-MM-DDTHH-MM
    
    for region, services in raw_results.items():
        s3_keys[region] = []
        
        for service_function, data in services.items():
            s3_key = f"raw/{date_folder}/{account_id}/{region}/{service_function}.json"
            
            try:
                s3_client.put_object(
                    Bucket=bucket_name,
                    Key=s3_key,
                    Body=json.dumps(data, cls=DateTimeEncoder, indent=2),
                    ContentType='application/json'
                )
                s3_keys[region].append(s3_key)
            except Exception as e:
                print(f"  ERROR storing {s3_key}: {e}")
    
    print(f"  Stored raw data to s3://{bucket_name}/raw/{date_folder}/{account_id}/")
    return s3_keys


def store_merged_to_s3(
    s3_client,
    bucket_name: str,
    all_accounts_data: Dict[str, Dict[str, Dict[str, Any]]],
    timestamp: str
) -> List[str]:
    """
    Store merged results across all accounts to S3.
    
    Structure: merged/{timestamp}/{service-function}.json
    Each record includes AccountId and Region fields.
    
    Args:
        s3_client: Boto3 S3 client
        bucket_name: S3 bucket name
        all_accounts_data: Dict organized as {account_id: {region: {service-function: data}}}
        timestamp: ISO timestamp for folder organization
        
    Returns:
        List of S3 keys for merged files
    """
    merged = {}
    date_folder = timestamp.replace(':', '-')[:16]
    
    # Merge data from all accounts and regions
    for account_id, regions in all_accounts_data.items():
        for region, services in regions.items():
            for service_function, data in services.items():
                if service_function not in merged:
                    merged[service_function] = []
                
                # Add account and region metadata to each item
                if isinstance(data, list):
                    for item in data:
                        if isinstance(item, dict):
                            item['AccountId'] = account_id
                            item['Region'] = region
                            merged[service_function].append(item)
                        else:
                            merged[service_function].append({
                                'Value': item,
                                'AccountId': account_id,
                                'Region': region
                            })
                elif isinstance(data, dict):
                    data['AccountId'] = account_id
                    data['Region'] = region
                    merged[service_function].append(data)
    
    # Write merged files
    s3_keys = []
    for service_function, items in merged.items():
        s3_key = f"merged/{date_folder}/{service_function}.json"
        
        try:
            s3_client.put_object(
                Bucket=bucket_name,
                Key=s3_key,
                Body=json.dumps(items, cls=DateTimeEncoder, indent=2),
                ContentType='application/json'
            )
            s3_keys.append(s3_key)
        except Exception as e:
            print(f"  ERROR storing merged {s3_key}: {e}")
    
    print(f"  Stored merged data to s3://{bucket_name}/merged/{date_folder}/ ({len(s3_keys)} files)")
    return s3_keys


def process_and_store_resources(
    dynamodb_client,
    s3_client,
    table_name: str,
    bucket_name: str,
    account_id: str,
    resources: List[Dict[str, Any]],
    raw_results: Dict[str, Dict[str, Any]] = None
) -> int:
    """
    Process resources and store in DynamoDB and S3.
    
    Args:
        dynamodb_client: Boto3 DynamoDB client
        s3_client: Boto3 S3 client
        table_name: DynamoDB table name
        bucket_name: S3 bucket name
        account_id: AWS account ID
        resources: List of discovered resources (normalized)
        raw_results: Optional raw results dict for S3 storage
        
    Returns:
        Number of resources processed
    """
    if not resources:
        return 0
    
    now = datetime.now(timezone.utc)
    timestamp = now.isoformat()
    
    # Store raw data to S3 (organized structure)
    if raw_results:
        store_raw_to_s3(s3_client, bucket_name, account_id, raw_results, timestamp)
    else:
        # Fallback: store all resources as single file
        date_prefix = now.strftime('%Y/%m/%d')
        s3_key = f"raw/{date_prefix}/{account_id}/inventory.json"
        s3_client.put_object(
            Bucket=bucket_name,
            Key=s3_key,
            Body=json.dumps({
                'accountId': account_id,
                'timestamp': timestamp,
                'resourceCount': len(resources),
                'resources': resources
            }, cls=DateTimeEncoder),
            ContentType='application/json'
        )
        print(f"  Stored raw data to s3://{bucket_name}/{s3_key}")
    
    # Prepare DynamoDB items
    items_to_write = []
    
    for resource in resources:
        resource_arn = generate_resource_arn(resource, account_id)
        resource_type = resource.get('resourceType', 'unknown')
        resource_id = resource.get('resourceId', 'unknown')
        name = resource.get('name', resource_id)
        region = resource.get('region', 'unknown')
        state = resource.get('state', 'unknown')
        tags = resource.get('tags', {})
        
        # Skip resources without valid ID
        if not resource_id or resource_id == 'unknown':
            continue
        
        # Create DynamoDB item
        item = {
            'pk': {'S': f'ACCOUNT#{account_id}'},
            'sk': {'S': f'INVENTORY#{resource_type}#{resource_arn}'},
            'gsi1pk': {'S': 'TYPE#INVENTORY'},
            'gsi1sk': {'S': f'{resource_type}#{region}#{name}'},
            'gsi2pk': {'S': f'REGION#{region}'},
            'gsi2sk': {'S': f'{resource_type}#{timestamp}'},
            'gsi3pk': {'S': f'RESOURCE_TYPE#{resource_type}'},
            'gsi3sk': {'S': f'{account_id}#{resource_id}'},
            'resourceId': {'S': str(resource_id)},
            'resourceArn': {'S': str(resource_arn)},
            'resourceType': {'S': str(resource_type)},
            'name': {'S': str(name)},
            'region': {'S': str(region)},
            'state': {'S': str(state)},
            'accountId': {'S': str(account_id)},
            'lastDiscoveredAt': {'S': timestamp},
            'discoveryStatus': {'S': 'active'},
        }
        
        # Add tags if present
        if tags and isinstance(tags, dict):
            item['tags'] = {'M': {str(k): {'S': str(v)} for k, v in tags.items()}}
        
        # Add service info
        if resource.get('service'):
            item['service'] = {'S': str(resource.get('service'))}
        
        items_to_write.append({'PutRequest': {'Item': item}})
    
    # Deduplicate items before writing to avoid ValidationException
    unique_items = {}
    for item_request in items_to_write:
        item = item_request['PutRequest']['Item']
        key = (item['pk']['S'], item['sk']['S'])
        unique_items[key] = item_request
    
    items_to_write = list(unique_items.values())

    # Batch write to DynamoDB (max 25 items per batch)
    batch_size = 25
    total_written = 0
    
    for i in range(0, len(items_to_write), batch_size):
        batch = items_to_write[i:i + batch_size]
        
        try:
            response = dynamodb_client.batch_write_item(
                RequestItems={table_name: batch}
            )
            
            # Handle unprocessed items with exponential backoff
            unprocessed = response.get('UnprocessedItems', {})
            retry_count = 0
            
            while unprocessed and retry_count < 5:
                time.sleep(2 ** retry_count)
                response = dynamodb_client.batch_write_item(RequestItems=unprocessed)
                unprocessed = response.get('UnprocessedItems', {})
                retry_count += 1
            
            total_written += len(batch) - len(unprocessed.get(table_name, []))
            
        except Exception as e:
            print(f"  ERROR writing batch to DynamoDB: {e}")
    
    print(f"  Stored {total_written} resources to DynamoDB")
    
    return total_written


def mark_missing_resources(
    dynamodb_client,
    table_name: str,
    account_id: str,
    discovered_arns: Set[str]
) -> int:
    """
    Mark resources as 'missing' if they weren't in the latest scan.
    
    Args:
        dynamodb_client: Boto3 DynamoDB client
        table_name: DynamoDB table name
        account_id: AWS account ID
        discovered_arns: Set of ARNs found in current scan
        
    Returns:
        Number of resources marked as missing
    """
    # Query existing resources for this account
    existing_resources = []
    paginator = dynamodb_client.get_paginator('query')
    
    for page in paginator.paginate(
        TableName=table_name,
        KeyConditionExpression='pk = :pk AND begins_with(sk, :sk_prefix)',
        ExpressionAttributeValues={
            ':pk': {'S': f'ACCOUNT#{account_id}'},
            ':sk_prefix': {'S': 'INVENTORY#'}
        },
        ProjectionExpression='sk, resourceArn, discoveryStatus'
    ):
        for item in page.get('Items', []):
            arn = item.get('resourceArn', {}).get('S', '')
            status = item.get('discoveryStatus', {}).get('S', 'active')
            if arn and status == 'active':
                existing_resources.append(item)
    
    # Mark resources not in discovered_arns as missing
    missing_count = 0
    timestamp = datetime.now(timezone.utc).isoformat()
    
    for item in existing_resources:
        arn = item.get('resourceArn', {}).get('S', '')
        sk = item.get('sk', {}).get('S', '')
        
        if arn not in discovered_arns:
            try:
                dynamodb_client.update_item(
                    TableName=table_name,
                    Key={
                        'pk': {'S': f'ACCOUNT#{account_id}'},
                        'sk': {'S': sk}
                    },
                    UpdateExpression='SET discoveryStatus = :status, lastDiscoveredAt = :ts',
                    ExpressionAttributeValues={
                        ':status': {'S': 'missing'},
                        ':ts': {'S': timestamp}
                    }
                )
                missing_count += 1
            except Exception as e:
                print(f"  ERROR marking resource as missing: {e}")
    
    if missing_count > 0:
        print(f"  Marked {missing_count} resources as missing")
    
    return missing_count


def get_discovered_arns(resources: List[Dict[str, Any]], account_id: str) -> Set[str]:
    """Extract set of ARNs from discovered resources."""
    arns = set()
    for resource in resources:
        arn = resource.get('resourceArn') or generate_resource_arn(resource, account_id)
        if arn:
            arns.add(arn)
    return arns
