"""
Inventory Runner - Parallel AWS Resource Scanner

Rewritten based on battle-tested aws-auto-inventory-automation.
Uses ThreadPoolExecutor for concurrent region and service scanning.
Implements exponential backoff for AWS API throttling.
"""
import boto3
import botocore
import concurrent.futures
import json
import logging
import os
import time
import traceback
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Callable
import sys

try:
    from src.data_processor import process_and_store_resources
except ImportError:
    try:
        from data_processor import process_and_store_resources
    except ImportError:
        pass  # Handle case where data_processor is not available

# Configure logging
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


class DateTimeEncoder(json.JSONEncoder):
    """Custom JSONEncoder that supports encoding datetime objects."""
    def default(self, o):
        if isinstance(o, datetime):
            return o.isoformat()
        return super().default(o)


def api_call_with_retry(
    client,
    function_name: str,
    parameters: Optional[Dict] = None,
    max_retries: int = 3,
    retry_delay: int = 2
) -> Callable:
    """
    Create a callable that makes an API call with exponential backoff.
    
    Handles:
    - Throttling errors
    - RequestLimitExceeded errors
    - General BotoCoreError with retry
    
    Args:
        client: Boto3 service client
        function_name: Name of the client method to call
        parameters: Optional parameters for the API call
        max_retries: Maximum retry attempts
        retry_delay: Base delay for exponential backoff
        
    Returns:
        Callable that executes the API call with retry logic
    """
    def api_call():
        for attempt in range(max_retries):
            try:
                function_to_call = getattr(client, function_name)
                if parameters:
                    return function_to_call(**parameters)
                else:
                    return function_to_call()
            except botocore.exceptions.ClientError as error:
                error_code = error.response["Error"]["Code"]
                if error_code in ("Throttling", "RequestLimitExceeded"):
                    if attempt < (max_retries - 1):
                        sleep_time = retry_delay ** attempt
                        logger.warning(f"API throttled, retrying in {sleep_time}s (attempt {attempt + 1}/{max_retries})")
                        time.sleep(sleep_time)
                    continue
                else:
                    raise
            except botocore.exceptions.BotoCoreError as error:
                if attempt < (max_retries - 1):
                    sleep_time = retry_delay ** attempt
                    logger.warning(f"BotoCoreError, retrying in {sleep_time}s: {error}")
                    time.sleep(sleep_time)
                continue
        return None
    
    return api_call


def get_assumed_role_session(
    role_arn: str,
    session_name: str = 'NucleusDiscovery',
    duration_seconds: int = 3600,
    external_id: Optional[str] = None
) -> boto3.Session:
    """
    Assume a cross-account role and return a boto3 session.
    
    Args:
        role_arn: ARN of the role to assume
        session_name: Name for the assumed role session
        duration_seconds: Duration for the session credentials
        external_id: Optional ExternalId for assume role condition
        
    Returns:
        boto3.Session with assumed role credentials
    """
    sts = boto3.client('sts')
    
    params = {
        'RoleArn': role_arn,
        'RoleSessionName': session_name,
        'DurationSeconds': duration_seconds
    }
    
    if external_id:
        params['ExternalId'] = external_id
        
    response = sts.assume_role(**params)
    
    credentials = response['Credentials']
    
    return boto3.Session(
        aws_access_key_id=credentials['AccessKeyId'],
        aws_secret_access_key=credentials['SecretAccessKey'],
        aws_session_token=credentials['SessionToken']
    )


def get_service_data(
    session: boto3.Session,
    region_name: str,
    service_config: Dict[str, Any],
    max_retries: int = 3,
    retry_delay: int = 2
) -> Optional[Dict[str, Any]]:
    """
    Get data for a specific AWS service in a region.
    
    Args:
        session: Boto3 session
        region_name: AWS region
        service_config: Service configuration dict with 'service', 'function', optional 'result_key', 'parameters'
        max_retries: Maximum retry attempts
        retry_delay: Base delay for exponential backoff
        
    Returns:
        Dictionary with service data or None on error
    """
    service_name = service_config['service']
    function_name = service_config['function']
    result_key = service_config.get('result_key')
    parameters = service_config.get('parameters')
    
    logger.info(f"Scanning {service_name}.{function_name} in {region_name}")
    
    try:
        client = session.client(service_name, region_name=region_name)
        
        if not hasattr(client, function_name):
            logger.warning(f"Function {function_name} not found on {service_name}")
            return None
        
        # Create retry-wrapped API call
        api_call = api_call_with_retry(client, function_name, parameters, max_retries, retry_delay)
        
        # Try pagination first
        response = None
        try:
            paginator = client.get_paginator(function_name)
            all_items = []
            paginate_params = parameters if parameters else {}
            
            for page in paginator.paginate(**paginate_params):
                if result_key:
                    items = page.get(result_key, [])
                else:
                    # Remove metadata and return the page
                    page.pop('ResponseMetadata', None)
                    items = page
                
                if isinstance(items, list):
                    all_items.extend(items)
                else:
                    all_items.append(items)
            
            response = all_items
            
        except botocore.exceptions.OperationNotPageableError:
            # Fallback to single call
            raw_response = api_call()
            if raw_response is None:
                return None
                
            if result_key:
                response = raw_response.get(result_key, [])
            else:
                if isinstance(raw_response, dict):
                    raw_response.pop('ResponseMetadata', None)
                response = raw_response
        
        except Exception as e:
            # Fallback for any other pagination error
            logger.debug(f"Pagination failed for {function_name}, using single call: {e}")
            raw_response = api_call()
            if raw_response is None:
                return None
                
            if result_key:
                response = raw_response.get(result_key, [])
            else:
                if isinstance(raw_response, dict):
                    raw_response.pop('ResponseMetadata', None)
                response = raw_response
        
        return {
            'region': region_name,
            'service': service_name,
            'function': function_name,
            'result': response
        }
        
    except Exception as e:
        logger.error(f"Error scanning {service_name}.{function_name} in {region_name}: {e}")
        logger.debug(traceback.format_exc())
        return None


def process_region(
    region: str,
    services: List[Dict[str, Any]],
    session: boto3.Session,
    max_retries: int = 3,
    retry_delay: int = 2,
    concurrent_services: Optional[int] = None
) -> List[Dict[str, Any]]:
    """
    Process all services for a single region in parallel.
    
    Args:
        region: AWS region name
        services: List of service configurations to scan
        session: Boto3 session
        max_retries: Maximum retry attempts
        retry_delay: Base delay for exponential backoff
        concurrent_services: Number of services to scan concurrently
        
    Returns:
        List of service scan results
    """
    logger.info(f"Processing region: {region}")
    region_results = []
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrent_services) as executor:
        future_to_service = {
            executor.submit(
                get_service_data,
                session,
                region,
                service,
                max_retries,
                retry_delay
            ): service
            for service in services
        }
        
        for future in concurrent.futures.as_completed(future_to_service):
            service = future_to_service[future]
            try:
                result = future.result()
                if result is not None and result.get('result'):
                    region_results.append(result)
                    result_count = len(result['result']) if isinstance(result['result'], list) else 1
                    logger.info(f"  {service['service']}.{service['function']}: {result_count} items")
                else:
                    logger.debug(f"  {service['service']}.{service['function']}: No data")
            except Exception as e:
                logger.error(f"  {service['service']}.{service['function']}: Error - {e}")
    
    logger.info(f"Completed region {region}: {len(region_results)} service results")
    return region_results


def run_inventory_scan(
    config: Dict[str, Any],
    role_arn: Optional[str] = None,
    external_id: Optional[str] = None,
    concurrent_regions: Optional[int] = None,
    concurrent_services: Optional[int] = None,
    max_retries: int = 3,
    retry_delay: int = 2
) -> Dict[str, Any]:
    """
    Run parallel inventory scan across regions and services.
    
    Args:
        config: Configuration dictionary with 'inventories' key
        role_arn: Optional role ARN for cross-account access
        external_id: Optional ExternalId for assume role condition
        concurrent_regions: Number of regions to scan concurrently
        concurrent_services: Number of services per region to scan concurrently
        max_retries: Maximum retry attempts for API calls
        retry_delay: Base delay for exponential backoff
        
    Returns:
        Dictionary with scan results organized by region and service
    """
    start_time = time.time()
    
    # Get session
    if role_arn:
        logger.info(f"Assuming role: {role_arn} with ExternalId: {external_id if external_id else 'None'}")
        try:
            session = get_assumed_role_session(role_arn, external_id=external_id)
        except Exception as e:
            logger.error(f"Failed to assume role {role_arn}: {e}")
            return {'resources': [], 'error': str(e), 'regions_scanned': 0, 'services_scanned': 0, 'elapsed_seconds': 0}
    else:
        session = boto3.Session()
    
    # Verify credentials
    try:
        sts = session.client('sts')
        identity = sts.get_caller_identity()
        logger.info(f"Authenticated as: {identity['Arn']}")
    except Exception as e:
        logger.error(f"Failed to verify credentials: {e}")
        return {'resources': [], 'error': str(e)}
    
    # Get configuration
    inventories = config.get('inventories', [])
    if not inventories:
        # Support direct service list format (like reference implementation)
        if isinstance(config, list):
            services = config
            regions = _get_default_regions(session)
        else:
            return {'resources': [], 'error': 'No inventories configured'}
    else:
        inventory = inventories[0]
        regions = inventory.get('aws', {}).get('region', [])
        services = inventory.get('sheets', [])
    
    # If regions is a list of DynamoDB items, extract strings
    if regions and isinstance(regions[0], dict) and 'S' in regions[0]:
        regions = [r.get('S', 'us-east-1') for r in regions]
    
    # If no regions, get all available regions
    if not regions:
        regions = _get_default_regions(session)
    
    logger.info(f"Scanning {len(regions)} regions with {len(services)} services")
    
    # Scan all regions in parallel
    all_results = []
    raw_results = {}  # Organized for S3 storage
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrent_regions) as executor:
        future_to_region = {
            executor.submit(
                process_region,
                region,
                services,
                session,
                max_retries,
                retry_delay,
                concurrent_services
            ): region
            for region in regions
        }
        
        for future in concurrent.futures.as_completed(future_to_region):
            region = future_to_region[future]
            try:
                region_results = future.result()
                
                # Organize results for S3
                raw_results[region] = {}
                for service_result in region_results:
                    key = f"{service_result['service']}-{service_result['function']}"
                    raw_results[region][key] = service_result['result']
                    
                    # Convert to normalized resource format
                    resources = normalize_resources(
                        service_result['result'],
                        service_result['service'],
                        service_result['function'],
                        region
                    )
                    all_results.extend(resources)
                    
            except Exception as e:
                logger.error(f"Error processing region {region}: {e}")
    
    elapsed_time = time.time() - start_time
    logger.info(f"Scan completed in {elapsed_time:.1f}s. Total resources: {len(all_results)}")
    
    return {
        'resources': all_results,
        'raw_results': raw_results,
        'regions_scanned': len(regions),
        'services_scanned': len(services),
        'elapsed_seconds': elapsed_time
    }


def _get_default_regions(session: boto3.Session) -> List[str]:
    """Get list of enabled AWS regions."""
    try:
        ec2 = session.client('ec2', region_name='us-east-1')
        response = ec2.describe_regions()
        return [
            r['RegionName'] for r in response['Regions']
            if r.get('OptInStatus') in ('opt-in-not-required', 'opted-in')
        ]
    except Exception:
        # Fallback to common regions
        return ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-south-1']


def normalize_resources(
    raw_data: Any,
    service: str,
    function: str,
    region: str
) -> List[Dict[str, Any]]:
    """
    Normalize raw API response into standard resource format.
    
    Args:
        raw_data: Raw API response data
        service: AWS service name
        function: API function name
        region: AWS region
        
    Returns:
        List of normalized resource dictionaries
    """
    resources = []
    
    if not raw_data:
        return resources
    
    # Handle list of items
    items = raw_data if isinstance(raw_data, list) else [raw_data]
    
    for item in items:
        if isinstance(item, str):
            # Handle ARN or ID strings
            resource = {
                'resourceType': f"{service}_{function}".replace('describe_', '').replace('list_', ''),
                'region': region,
                'service': service,
                'resourceId': item.split('/')[-1] if '/' in item else item.split(':')[-1],
                'resourceArn': item if item.startswith('arn:') else '',
                'name': item.split('/')[-1] if '/' in item else item.split(':')[-1],
                'state': 'unknown',
                'tags': {},
                'rawData': item
            }
        elif isinstance(item, dict):
            resource = {
                'resourceType': f"{service}_{function}".replace('describe_', '').replace('list_', ''),
                'region': region,
                'service': service,
                'rawData': item,
            }
            resource.update(extract_resource_identifiers(item, service))
        else:
            continue
        
        resources.append(resource)
    
    return resources


def extract_resource_identifiers(resource: Dict, service: str) -> Dict[str, Any]:
    """Extract common identifiers from a resource dictionary."""
    identifiers = {
        'resourceId': '',
        'resourceArn': '',
        'name': '',
        'state': 'unknown',
        'tags': {},
    }
    
    # ID extraction based on common patterns
    id_keys = [
        'InstanceId', 'DBInstanceIdentifier', 'DBClusterIdentifier', 'ClusterIdentifier',
        'FunctionName', 'BucketName', 'VolumeId', 'VpcId', 'SubnetId', 'GroupId',
        'KeyId', 'AutoScalingGroupName', 'LoadBalancerArn', 'TopicArn', 'QueueUrl',
        'FileSystemId', 'NatGatewayId', 'DistributionId', 'TableName', 'StreamName',
        'CacheClusterId', 'ReplicationGroupId', 'ClusterArn', 'ServiceArn', 'TaskArn'
    ]
    
    for id_key in id_keys:
        if id_key in resource:
            identifiers['resourceId'] = resource[id_key]
            break
    
    # ARN extraction
    arn_keys = ['Arn', 'ARN', 'FunctionArn', 'DBInstanceArn', 'DBClusterArn',
                'LoadBalancerArn', 'TopicArn', 'QueueArn', 'FileSystemArn', 
                'KeyArn', 'ClusterArn', 'ServiceArn', 'TaskArn', 'TableArn']
    
    for arn_key in arn_keys:
        if arn_key in resource:
            identifiers['resourceArn'] = resource[arn_key]
            break
    
    # Name extraction
    name_keys = ['Name', 'DBInstanceIdentifier', 'DBClusterIdentifier', 'FunctionName',
                 'BucketName', 'AutoScalingGroupName', 'LoadBalancerName', 'FileSystemId',
                 'TableName', 'TopicName', 'QueueName']
    
    for name_key in name_keys:
        if name_key in resource:
            identifiers['name'] = resource[name_key]
            break
    
    # Try tags for name
    if not identifiers['name']:
        tags = resource.get('Tags', resource.get('TagList', []))
        if isinstance(tags, list):
            for tag in tags:
                if isinstance(tag, dict) and tag.get('Key') == 'Name':
                    identifiers['name'] = tag.get('Value', '')
                    break
    
    # State extraction
    state = resource.get('State', resource.get('DBInstanceStatus', 
                         resource.get('Status', resource.get('InstanceStatus', {}))))
    if isinstance(state, dict):
        identifiers['state'] = state.get('Name', state.get('Code', 'unknown'))
    elif isinstance(state, str):
        identifiers['state'] = state
    
    # Tags extraction
    tags = resource.get('Tags', resource.get('TagList', []))
    if isinstance(tags, list):
        identifiers['tags'] = {
            tag.get('Key', ''): tag.get('Value', '') 
            for tag in tags if isinstance(tag, dict)
        }
    elif isinstance(tags, dict):
        identifiers['tags'] = tags
    
    # Default name to ID
    if not identifiers['name']:
        identifiers['name'] = identifiers['resourceId']
    
    return identifiers


def get_active_accounts(dynamodb_client, table_name: str) -> List[Dict[str, Any]]:
    """Fetch all active accounts from DynamoDB."""
    accounts = []
    paginator = dynamodb_client.get_paginator('query')
    
    try:
        paginator_iterator = paginator.paginate(
            TableName=table_name,
            IndexName='GSI1',
            KeyConditionExpression='gsi1pk = :pk',
            ExpressionAttributeValues={
                ':pk': {'S': 'TYPE#ACCOUNT'},
                ':active': {'BOOL': True}
            },
            FilterExpression='#active = :active',
            ExpressionAttributeNames={'#active': 'active'},
        )
        
        for page in paginator_iterator:
            for item in page.get('Items', []):
                accounts.append({
                    'accountId': item.get('accountId', item.get('account_id', {})).get('S', ''),
                    'accountName': item.get('accountName', item.get('account_name', {})).get('S', ''),
                    'roleArn': item.get('roleArn', item.get('role_arn', {})).get('S', ''),
                    'externalId': item.get('externalId', item.get('external_id', {})).get('S', ''),
                    'regions': extract_regions(item.get('regions', {})),
                })
    except Exception as e:
        logger.error(f"Error fetching active accounts: {e}")
        return []
            
    return accounts


def extract_regions(regions_item: Dict) -> List[str]:
    """Extract regions list from DynamoDB item format."""
    if not regions_item:
        return ['us-east-1', 'ap-south-1']
    
    if 'L' in regions_item:
        return [r.get('S', 'us-east-1') for r in regions_item['L']]
    elif 'SS' in regions_item:
        return list(regions_item['SS'])
    
    return ['us-east-1', 'ap-south-1']


def _get_default_services():
    """Return default services to scan if no config provided."""
    """
    Default services configuration to scan when no config is provided.
    Includes commonly used AWS services.
    """
    return [
        {'service': 'ec2', 'function': 'describe_instances', 'result_key': 'Reservations'},
        {'service': 'rds', 'function': 'describe_db_instances', 'result_key': 'DBInstances'},
        {'service': 'ecs', 'function': 'list_clusters', 'result_key': 'clusterArns'},
        {'service': 'autoscaling', 'function': 'describe_auto_scaling_groups', 'result_key': 'AutoScalingGroups'},
        {'service': 'lambda', 'function': 'list_functions', 'result_key': 'Functions'},
        {'service': 'dynamodb', 'function': 'list_tables', 'result_key': 'TableNames'},
        {'service': 's3', 'function': 'list_buckets', 'result_key': 'Buckets'}
    ]


def scan_all_active_accounts(
    app_table_name: str,
    inventory_table_name: str,
    inventory_bucket: str,
    config: Optional[Dict[str, Any]] = None,
    concurrent_regions: int = 5,
    concurrent_services: int = 10
) -> Dict[str, Any]:
    """
    Scan all active accounts and store results in DynamoDB.
    
    Args:
        app_table_name: Name of the App DynamoDB table (for accounts)
        inventory_table_name: Name of the Inventory DynamoDB table (for results)
        inventory_bucket: Name of the S3 bucket (for results)
        config: Service configuration (optional)
        concurrent_regions: Number of concurrent regions
        concurrent_services: Number of concurrent services
        
    Returns:
        Summary dictionary with scan results
    """
    dynamodb = boto3.client('dynamodb')
    s3 = boto3.client('s3')
    
    # 1. Fetch active accounts
    accounts = get_active_accounts(dynamodb, app_table_name)
    logger.info(f"Found {len(accounts)} active accounts to scan")
    
    if not accounts:
        return {'status': 'success', 'message': 'No active accounts found', 'scanned_count': 0}

    total_resources = 0
    successful_accounts = 0
    failed_accounts = 0
    results_summary = {}

    # 2. Iterate and scan each account
    for account in accounts:
        account_id = account.get('accountId')
        account_name = account.get('accountName', account_id)
        role_arn = account.get('roleArn')
        external_id = account.get('externalId')
        
        if not account_id:
            logger.warning("Skipping account with missing ID")
            continue
            
        logger.info(f"Starting scan for account: {account_name} ({account_id})")
        
        try:
            # Use provided config or default
            services_config = config.get('services') if config else _get_default_services()
            current_config = {'inventories': [{'aws': {'region': account.get('regions', [])}, 'sheets': services_config}]}
            
            # Run scan for this account
            scan_result = run_inventory_scan(
                current_config,
                role_arn=role_arn,
                external_id=external_id,
                concurrent_regions=concurrent_regions,
                concurrent_services=concurrent_services
            )
            
            resources = scan_result.get('resources', [])
            raw_results = scan_result.get('raw_results', {})
            
            # Process and store results
            try:
                # Try to call process_and_store_resources from data_processor
                if 'process_and_store_resources' in globals():
                    process_func = globals()['process_and_store_resources']
                    count = process_func(
                        dynamodb_client=dynamodb,
                        s3_client=s3,
                        table_name=inventory_table_name,
                        bucket_name=inventory_bucket,
                        account_id=account_id,
                        resources=resources,
                        raw_results=raw_results
                    )
                    logger.info(f"Stored {count} resources for account {account_id}")
                    total_resources += count
                else:
                    logger.warning("process_and_store_resources not available, skipping storage")
                    count = len(resources)
                    total_resources += count
            except NameError:
                 logger.warning("process_and_store_resources not defined")
                 count = len(resources)
            
            successful_accounts += 1
            results_summary[account_id] = {'status': 'success', 'count': count}
            
        except Exception as e:
            logger.error(f"Error scanning account {account_id}: {e}")
            failed_accounts += 1
            results_summary[account_id] = {'status': 'failed', 'error': str(e)}

    return {
        'status': 'success' if failed_accounts == 0 else 'partial_success',
        'total_resources': total_resources,
        'successful_accounts': successful_accounts,
        'failed_accounts': failed_accounts,
        'details': results_summary
    }
