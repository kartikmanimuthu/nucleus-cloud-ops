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
        # Check for custom handlers first
        if service_name == 'ecs' and function_name == 'list_clusters':
            return _scan_ecs_deep(session, region_name)
        elif service_name == 'lambda' and function_name == 'list_functions':
            return _scan_lambda_deep(session, region_name)
        elif service_name == 's3' and function_name == 'list_buckets':
            return _scan_s3_deep(session, region_name)
        elif service_name == 'dynamodb' and function_name == 'list_tables':
            return _scan_dynamodb_deep(session, region_name)
        elif service_name == 'rds' and function_name == 'describe_db_instances':
            return _scan_rds_deep(session, region_name)
        elif service_name == 'rds' and function_name == 'describe_db_instances':
            return _scan_rds_deep(session, region_name)
        elif service_name == 'elbv2' and function_name == 'describe_load_balancers':
            return _scan_elbv2_deep(session, region_name)
        elif service_name == 'acm' and function_name == 'list_certificates':
            return _scan_acm_deep(session, region_name)
        elif service_name == 'apigateway' and function_name == 'get_rest_apis':
            return _scan_apigateway_deep(session, region_name)
        elif service_name == 'kms' and function_name == 'list_keys':
            return _scan_kms_deep(session, region_name)
            
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


def _scan_ecs_deep(session: boto3.Session, region_name: str) -> Dict[str, Any]:
    """
    Deep scan for ECS: Clusters -> Services -> Tags
    """
    ecs = session.client('ecs', region_name=region_name)
    all_services = []
    
    try:
        # 1. List Clusters
        cluster_arns = []
        paginator = ecs.get_paginator('list_clusters')
        for page in paginator.paginate():
            cluster_arns.extend(page.get('clusterArns', []))
            
        # 2. For each cluster, list and describe services
        for cluster_arn in cluster_arns:
            list_svc_paginator = ecs.get_paginator('list_services')
            service_arns = []
            for svc_page in list_svc_paginator.paginate(cluster=cluster_arn):
                service_arns.extend(svc_page.get('serviceArns', []))
            
            # Describe in batches of 10
            for i in range(0, len(service_arns), 10):
                batch = service_arns[i:i+10]
                if not batch: continue
                
                try:
                    resp = ecs.describe_services(cluster=cluster_arn, services=batch, include=['TAGS'])
                    for svc in resp.get('services', []):
                        # Ensure nice tag format if missing
                        if 'tags' not in svc:
                            svc['tags'] = []
                        # Flatten tags for consistency if needed, but data_processor handles list of dicts
                        # Just ensure we have them.
                        svc['ClusterArn'] = cluster_arn # Add context
                        all_services.append(svc)
                except Exception as e:
                    logger.error(f"Error describing ECS services in {cluster_arn}: {e}")

    except Exception as e:
        logger.error(f"Error in deep ECS scan: {e}")
        return None

    return {
        'region': region_name,
        'service': 'ecs',
        'function': 'describe_services', # Standard function name for proper resource type normalization
        'result': all_services
    }

def _scan_lambda_deep(session: boto3.Session, region_name: str) -> Dict[str, Any]:
    """
    Deep scan for Lambda: Functions -> Tags
    """
    lam = session.client('lambda', region_name=region_name)
    all_functions = []
    
    try:
        paginator = lam.get_paginator('list_functions')
        for page in paginator.paginate():
            for func in page.get('Functions', []):
                try:
                    # Fetch tags
                    tags_resp = lam.list_tags(Resource=func['FunctionArn'])
                    # print("lambda tags>>>>>>>",tags_resp)
                    func_tags = tags_resp.get('Tags', {})
                    # Convert dict tags to list of dicts format specific to this project's convention if needed?
                    # AWS returns {'Key': 'Value'} validation usually wants list or dict. 
                    # data_processor handles both.
                    # We inject it back into the object as 'Tags' (capitalized) or 'tags'
                    # AWS list_functions returns 'Functions' list.
                    
                    # Store as list of dicts for consistency with other resources if needed, 
                    # but AWS Resource Groups Tagging API standard is what we usually see.
                    # list_tags return Dict[str, str].
                    # Let's convert to [{'Key': k, 'Value': v}] logic if strict, 
                    # but data_processor extracts from both.
                    
                    # Let's attach as 'Tags' (list) to match other resources if possible
                    tag_list = [{'Key': k, 'Value': v} for k, v in func_tags.items()]
                    func['Tags'] = tag_list 
                    
                    all_functions.append(func)
                except Exception as e:
                    logger.warning(f"Error getting tags for lambda {func.get('FunctionName')}: {e}")
                    all_functions.append(func) # Append anyway
                    
    except Exception as e:
        logger.error(f"Error in deep Lambda scan: {e}")
        return None

    return {
        'region': region_name,
        'service': 'lambda',
        'function': 'list_functions',
        'result': all_functions
    }


def _scan_s3_deep(session: boto3.Session, region_name: str) -> Dict[str, Any]:
    """
    Deep scan for S3: Buckets -> Tags
    """
    s3 = session.client('s3', region_name=region_name)
    all_buckets = []
    
    try:
        resp = s3.list_buckets()
        buckets = resp.get('Buckets', [])
        
        for bucket in buckets:
            try:
                # Fetch tags
                tags_resp = s3.get_bucket_tagging(Bucket=bucket['Name'])
                tag_set = tags_resp.get('TagSet', [])
                # Convert to dict for easier consumption if needed, but keeping original format is safer for now
                # Or inject as 'Tags' list of dicts {'Key': 'k', 'Value': 'v'}
                bucket['Tags'] = tag_set
            except Exception:
                # Tags might not exist or be accessible
                bucket['Tags'] = []
            
            # Since S3 is global, we might want to filter by region?
            # Or just return all buckets for this region scan?
            # Usually inventory runs per region, if we return all buckets for every region scan, we duplicate.
            # But duplicate handling at ingestion usually handles this (app table has normalized ID).
            # Let's check bucket location to be precise if we want to assign correct region.
            try:
                loc_resp = s3.get_bucket_location(Bucket=bucket['Name'])
                loc = loc_resp.get('LocationConstraint')
                # If explicit region matches our scan region, include it.
                # If loc is None, it means us-east-1.
                bucket_region = loc if loc else 'us-east-1'
                if bucket_region == 'EU': bucket_region = 'eu-west-1' # Legacy mapping
                
                # If we are scanning a specific region, only return buckets in that region?
                if bucket_region == region_name:
                     all_buckets.append(bucket)
                # Else skip to avoid duplicates across regions?
                # If we skip, we ensure each bucket is reported exactly once.
            except Exception as e:
                logger.warning(f"Could not get location for bucket {bucket['Name']}: {e}")
                # Include anyway if check fails? Or skip?
                # Safe to skip if we assume eventually consistent
                pass

    except Exception as e:
        logger.error(f"Error in deep S3 scan: {e}")
        return None

    return {
        'region': region_name,
        'service': 's3',
        'function': 'list_buckets',
        'result': all_buckets
    }


def _scan_dynamodb_deep(session: boto3.Session, region_name: str) -> Dict[str, Any]:
    """
    Deep scan for DynamoDB: Tables -> Describe -> Tags
    """
    ddb = session.client('dynamodb', region_name=region_name)
    all_tables = []
    
    try:
        paginator = ddb.get_paginator('list_tables')
        table_names = []
        for page in paginator.paginate():
            table_names.extend(page.get('TableNames', []))
            
        for table_name in table_names:
            try:
                # Describe table to get ARN and details
                desc = ddb.describe_table(TableName=table_name)
                table = desc.get('Table', {})
                arn = table.get('TableArn')
                
                if arn:
                    # List tags
                    tags_resp = ddb.list_tags_of_resource(ResourceArn=arn)
                    tags = tags_resp.get('Tags', [])
                    table['Tags'] = tags
                
                all_tables.append(table)
            except Exception as e:
                logger.warning(f"Error describing table {table_name}: {e}")
    except Exception as e:
        logger.error(f"Error in deep DynamoDB scan: {e}")
        return None

    return {
        'region': region_name,
        'service': 'dynamodb',
        'function': 'list_tables', # Maps to describe_table output structure essentially
        'result': all_tables # This is List[TableDescription] basically
    }


def _scan_rds_deep(session: boto3.Session, region_name: str) -> Dict[str, Any]:
    """
    Deep scan for RDS: DBInstances -> Tags
    """
    rds = session.client('rds', region_name=region_name)
    all_instances = []
    
    try:
        paginator = rds.get_paginator('describe_db_instances')
        for page in paginator.paginate():
            for instance in page.get('DBInstances', []):
                try:
                    arn = instance.get('DBInstanceArn')
                    if arn:
                        tags_resp = rds.list_tags_for_resource(ResourceName=arn)
                        # Tags are returned as List[Dict['Key', 'Value']]
                        # Inject directly into 'TagList' (RDS typical key) or 'Tags'
                        instance['TagList'] = tags_resp.get('TagList', [])
                except Exception as e:
                    logger.warning(f"Error getting tags for RDS {instance.get('DBInstanceIdentifier')}: {e}")
                
                all_instances.append(instance)
    except Exception as e:
        logger.error(f"Error in deep RDS scan: {e}")
        return None

    return {
        'region': region_name,
        'service': 'rds',
        'function': 'describe_db_instances',
        'result': all_instances
    }


def _scan_elbv2_deep(session: boto3.Session, region_name: str) -> Dict[str, Any]:
    """
    Deep scan for ELBv2: LoadBalancers -> Tags (Batch)
    """
    elbv2 = session.client('elbv2', region_name=region_name)
    all_lbs = []
    
    try:
        paginator = elbv2.get_paginator('describe_load_balancers')
        
        # Collect all ARNs first? Or process page by page?
        # describe_tags accepts up to 20 ARNs.
        # Let's process page by page (page size usually 50-100? or 400?)
        
        for page in paginator.paginate():
            lbs = page.get('LoadBalancers', [])
            if not lbs: continue
            
            # Batch ARNs for tag fetching
            # Create map ARN -> LB object to attach tags later
            arn_map = {lb['LoadBalancerArn']: lb for lb in lbs}
            arns = list(arn_map.keys())
            
            # Process in chunks of 20
            for i in range(0, len(arns), 20):
                chunk = arns[i:i+20]
                try:
                    tags_resp = elbv2.describe_tags(ResourceArns=chunk)
                    for tag_desc in tags_resp.get('TagDescriptions', []):
                        resource_arn = tag_desc.get('ResourceArn')
                        tags = tag_desc.get('Tags', [])
                        
                        if resource_arn in arn_map:
                            arn_map[resource_arn]['Tags'] = tags
                            
                except Exception as e:
                    logger.warning(f"Error getting tags for ELB batch: {e}")
            
            all_lbs.extend(lbs)
            
    except Exception as e:
        logger.error(f"Error in deep ELBv2 scan: {e}")
        return None

    return {
        'region': region_name,
        'service': 'elbv2',
        'function': 'describe_load_balancers',
        'result': all_lbs
    }


def _scan_acm_deep(session: boto3.Session, region_name: str) -> Dict[str, Any]:
    """Deep scan for ACM: Certificates -> Tags"""
    acm = session.client('acm', region_name=region_name)
    all_certs = []
    
    try:
        paginator = acm.get_paginator('list_certificates')
        for page in paginator.paginate():
            for cert in page.get('CertificateSummaryList', []):
                try:
                    arn = cert.get('CertificateArn')
                    if arn:
                        tags_resp = acm.list_tags_for_certificate(CertificateArn=arn)
                        cert['Tags'] = tags_resp.get('Tags', [])
                except Exception as e:
                    logger.warning(f"Error getting tags for ACM cert {cert.get('CertificateArn')}: {e}")
                all_certs.append(cert)
    except Exception as e:
        logger.error(f"Error in deep ACM scan: {e}")
        return None

    return {
        'region': region_name,
        'service': 'acm',
        'function': 'list_certificates',
        'result': all_certs
    }


def _scan_apigateway_deep(session: boto3.Session, region_name: str) -> Dict[str, Any]:
    """Deep scan for API Gateway: RestApis -> Tags"""
    apigw = session.client('apigateway', region_name=region_name)
    all_apis = []
    
    try:
        paginator = apigw.get_paginator('get_rest_apis')
        for page in paginator.paginate():
            for api in page.get('items', []):
                try:
                    api_id = api.get('id')
                    if api_id:
                        # Construct ARN manually as get_rest_apis doesn't return it usually
                        # format: arn:aws:apigateway:{region}::/restapis/{api_id}
                        arn = f"arn:aws:apigateway:{region_name}::/restapis/{api_id}"
                        tags_resp = apigw.get_tags(resourceArn=arn)
                        api['tags'] = tags_resp.get('tags', {}) # Returns dict
                        api['Arn'] = arn # Inject ARN since we computed it
                except Exception as e:
                    logger.warning(f"Error getting tags for APIGW {api.get('name')}: {e}")
                all_apis.append(api)
    except Exception as e:
        logger.error(f"Error in deep APIGateway scan: {e}")
        return None

    return {
        'region': region_name,
        'service': 'apigateway',
        'function': 'get_rest_apis',
        'result': all_apis
    }


def _scan_kms_deep(session: boto3.Session, region_name: str) -> Dict[str, Any]:
    """Deep scan for KMS: Keys -> Tags"""
    kms = session.client('kms', region_name=region_name)
    all_keys = []
    
    try:
        paginator = kms.get_paginator('list_keys')
        for page in paginator.paginate():
            for key in page.get('Keys', []):
                try:
                    key_id = key.get('KeyId')
                    if key_id:
                        # List tags
                        tags_resp = kms.list_resource_tags(KeyId=key_id)
                        key['Tags'] = tags_resp.get('Tags', [])
                        
                        # Describe key for details? Optional but useful.
                        # Logic: list_keys only returns KeyId and KeyArn.
                        # Users usually want description, state, etc.
                        desc = kms.describe_key(KeyId=key_id)
                        key_metadata = desc.get('KeyMetadata', {})
                        key.update(key_metadata) # Merge metadata into key object
                        
                except Exception as e:
                    logger.warning(f"Error processing KMS key {key.get('KeyId')}: {e}")
                all_keys.append(key)
    except Exception as e:
        logger.error(f"Error in deep KMS scan: {e}")
        return None

    return {
        'region': region_name,
        'service': 'kms',
        'function': 'list_keys',
        'result': all_keys
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
                'resourceType': f"{service}_{function}".replace('describe_', '').replace('list_', '').replace('get_', ''),
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
                'resourceType': f"{service}_{function}".replace('describe_', '').replace('list_', '').replace('get_', ''),
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
    tags = resource.get('Tags', resource.get('TagList', resource.get('tags', [])))
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
