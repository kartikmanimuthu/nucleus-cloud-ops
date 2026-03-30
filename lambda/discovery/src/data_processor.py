"""
Data Processor - Stores discovered resources in DynamoDB and S3.

Enhanced for dual persistence with organized S3 structure and
optimized DynamoDB schema for web UI filtering.
"""
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Dict, Any, List, Set
from decimal import Decimal

try:
    from src.pg_writer import is_pg_enabled, write_resources_to_pg
except ImportError:
    from pg_writer import is_pg_enabled, write_resources_to_pg


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


def _extract_metadata(resource: Dict[str, Any], resource_type: str) -> Dict[str, Any]:
    """
    Extract structured metadata based on resource type.
    Different resource types have different relevant metadata fields.
    Uses the 'rawData' field which contains the original AWS API response.
    
    Args:
        resource: The resource dictionary from discovery
        resource_type: The type of resource (e.g., 'ec2_instances', 'rds_instances')
        
    Returns:
        Dictionary with resource-type-specific metadata
    """
    metadata = {}
    
    # Get raw data from the discovery response
    raw_data = resource.get('rawData', {})
    if not isinstance(raw_data, dict):
        raw_data = {}
    
    # Common metadata for all resources
    if raw_data.get('CreationTime'):
        metadata['createdAt'] = str(raw_data.get('CreationTime'))
    if raw_data.get('LaunchTime'):
        metadata['launchTime'] = str(raw_data.get('LaunchTime'))
    
    # EC2 Instance specific metadata
    if resource_type == 'ec2_instances':
        metadata.update({
            'instanceType': raw_data.get('InstanceType'),
            'platform': raw_data.get('Platform') or raw_data.get('PlatformDetails'),
            'vpcId': raw_data.get('VpcId'),
            'subnetId': raw_data.get('SubnetId'),
            'privateIpAddress': raw_data.get('PrivateIpAddress'),
            'publicIpAddress': raw_data.get('PublicIpAddress'),
            'iamInstanceProfile': raw_data.get('IamInstanceProfile', {}).get('Arn') if isinstance(raw_data.get('IamInstanceProfile'), dict) else None,
            'launchTime': str(raw_data.get('LaunchTime')) if raw_data.get('LaunchTime') else None,
            'architecture': raw_data.get('Architecture'),
            'rootDeviceType': raw_data.get('RootDeviceType'),
        })
    
    # RDS Instance specific metadata  
    elif resource_type == 'rds_db_instances' or resource_type == 'rds_instances':
        metadata.update({
            'engine': raw_data.get('Engine'),
            'engineVersion': raw_data.get('EngineVersion'),
            'dbInstanceClass': raw_data.get('DBInstanceClass'),
            'allocatedStorage': raw_data.get('AllocatedStorage'),
            'multiAZ': raw_data.get('MultiAZ'),
            'storageType': raw_data.get('StorageType'),
            'vpcId': raw_data.get('DBSubnetGroup', {}).get('VpcId') if isinstance(raw_data.get('DBSubnetGroup'), dict) else None,
            'endpoint': raw_data.get('Endpoint', {}).get('Address') if isinstance(raw_data.get('Endpoint'), dict) else None,
            'port': raw_data.get('Endpoint', {}).get('Port') if isinstance(raw_data.get('Endpoint'), dict) else None,
        })
    
    # Lambda specific metadata
    elif resource_type == 'lambda_functions':
        metadata.update({
            'runtime': raw_data.get('Runtime'),
            'handler': raw_data.get('Handler'),
            'memorySize': raw_data.get('MemorySize'),
            'timeout': raw_data.get('Timeout'),
            'codeSize': raw_data.get('CodeSize'),
            'lastModified': raw_data.get('LastModified'),
            'packageType': raw_data.get('PackageType'),
            'architectures': raw_data.get('Architectures'),
        })
    
    # DynamoDB specific metadata
    elif resource_type == 'dynamodb_tables':
        metadata.update({
            'tableStatus': raw_data.get('TableStatus'),
            'itemCount': raw_data.get('ItemCount'),
            'tableSizeBytes': raw_data.get('TableSizeBytes'),
            'billingMode': raw_data.get('BillingModeSummary', {}).get('BillingMode') if isinstance(raw_data.get('BillingModeSummary'), dict) else None,
            'tableId': raw_data.get('TableId'),
        })
    
    # S3 specific metadata
    elif resource_type == 's3_buckets':
        metadata.update({
            'creationDate': str(raw_data.get('CreationDate')) if raw_data.get('CreationDate') else None,
        })

    # ACM Certificate specific metadata
    elif resource_type == 'acm_certificates':
        metadata.update({
            'domainName': raw_data.get('DomainName'),
            'status': raw_data.get('Status'),
            'type': raw_data.get('Type'),
            'issuer': raw_data.get('Issuer'),
            'notBefore': str(raw_data.get('NotBefore')) if raw_data.get('NotBefore') else None,
            'notAfter': str(raw_data.get('NotAfter')) if raw_data.get('NotAfter') else None,
            'keyAlgorithm': raw_data.get('KeyAlgorithm'),
            'renewalEligibility': raw_data.get('RenewalEligibility'),
        })

    # ECR Repository specific metadata
    elif resource_type == 'ecr_repositories':
        metadata.update({
            'repositoryUri': raw_data.get('repositoryUri'),
            'imageTagMutability': raw_data.get('imageTagMutability'),
            'imageScanningConfiguration': raw_data.get('imageScanningConfiguration', {}).get('scanOnPush') if isinstance(raw_data.get('imageScanningConfiguration'), dict) else None,
            'encryptionType': raw_data.get('encryptionConfiguration', {}).get('encryptionType') if isinstance(raw_data.get('encryptionConfiguration'), dict) else None,
        })

    # VPC specific metadata
    elif resource_type == 'ec2_vpcs':
        metadata.update({
            'cidrBlock': raw_data.get('CidrBlock'),
            'isDefault': raw_data.get('IsDefault'),
            'state': raw_data.get('State'),
            'dhcpOptionsId': raw_data.get('DhcpOptionsId'),
            'instanceTenancy': raw_data.get('InstanceTenancy'),
        })

    # Subnet specific metadata
    elif resource_type == 'ec2_subnets':
        metadata.update({
            'cidrBlock': raw_data.get('CidrBlock'),
            'availabilityZone': raw_data.get('AvailabilityZone'),
            'availableIpAddressCount': raw_data.get('AvailableIpAddressCount'),
            'mapPublicIpOnLaunch': raw_data.get('MapPublicIpOnLaunch'),
            'vpcId': raw_data.get('VpcId'),
        })

    # Security Group specific metadata
    elif resource_type == 'ec2_security_groups':
        inbound = raw_data.get('IpPermissions', [])
        outbound = raw_data.get('IpPermissionsEgress', [])
        metadata.update({
            'description': raw_data.get('Description'),
            'vpcId': raw_data.get('VpcId'),
            'inboundRulesCount': len(inbound) if isinstance(inbound, list) else 0,
            'outboundRulesCount': len(outbound) if isinstance(outbound, list) else 0,
        })

    # Network Interface specific metadata
    elif resource_type == 'ec2_network_interfaces':
        attachment = raw_data.get('Attachment', {})
        association = raw_data.get('Association', {})
        metadata.update({
            'privateIpAddress': raw_data.get('PrivateIpAddress'),
            'publicIp': association.get('PublicIp') if isinstance(association, dict) else None,
            'macAddress': raw_data.get('MacAddress'),
            'vpcId': raw_data.get('VpcId'),
            'subnetId': raw_data.get('SubnetId'),
            'attachedTo': attachment.get('InstanceId') if isinstance(attachment, dict) else None,
            'description': raw_data.get('Description'),
            'interfaceType': raw_data.get('InterfaceType'),
        })

    # NAT Gateway specific metadata
    elif resource_type == 'ec2_nat_gateways':
        addresses = raw_data.get('NatGatewayAddresses', [])
        public_ip = None
        private_ip = None
        if isinstance(addresses, list) and addresses:
            public_ip = addresses[0].get('PublicIp')
            private_ip = addresses[0].get('PrivateIp')
        metadata.update({
            'publicIp': public_ip,
            'privateIp': private_ip,
            'vpcId': raw_data.get('VpcId'),
            'subnetId': raw_data.get('SubnetId'),
        })

    # Load Balancer specific metadata
    elif resource_type == 'elbv2_load_balancers':
        state = raw_data.get('State', {})
        metadata.update({
            'dnsName': raw_data.get('DNSName'),
            'type': raw_data.get('Type'),
            'scheme': raw_data.get('Scheme'),
            'vpcId': raw_data.get('VpcId'),
            'ipAddressType': raw_data.get('IpAddressType'),
            'stateCode': state.get('Code') if isinstance(state, dict) else None,
        })

    # ElastiCache Cluster specific metadata
    elif resource_type == 'elasticache_cache_clusters':
        endpoint = raw_data.get('ConfigurationEndpoint') or raw_data.get('RedisConfiguration', {})
        metadata.update({
            'engine': raw_data.get('Engine'),
            'engineVersion': raw_data.get('EngineVersion'),
            'cacheNodeType': raw_data.get('CacheNodeType'),
            'numCacheNodes': raw_data.get('NumCacheNodes'),
            'preferredAz': raw_data.get('PreferredAvailabilityZone'),
            'clusterStatus': raw_data.get('CacheClusterStatus'),
        })

    # KMS Key specific metadata
    elif resource_type == 'kms_keys':
        key_meta = raw_data.get('KeyMetadata', raw_data)
        metadata.update({
            'enabled': key_meta.get('Enabled'),
            'keyState': key_meta.get('KeyState'),
            'keyManager': key_meta.get('KeyManager'),
            'keySpec': key_meta.get('KeySpec'),
            'keyUsage': key_meta.get('KeyUsage'),
            'description': key_meta.get('Description'),
            'origin': key_meta.get('Origin'),
        })

    # SNS Topic specific metadata
    elif resource_type == 'sns_topics':
        metadata.update({
            'topicArn': raw_data.get('TopicArn'),
        })

    # SQS Queue specific metadata
    elif resource_type == 'sqs_queues':
        # list_queues returns URL strings; rawData may be the URL string
        queue_url = raw_data.get('raw_value') or raw_data.get('QueueUrl', '')
        metadata.update({
            'queueUrl': queue_url,
        })

    # EFS File System specific metadata
    elif resource_type == 'efs_file_systems':
        size = raw_data.get('SizeInBytes', {})
        metadata.update({
            'lifecycleState': raw_data.get('LifeCycleState'),
            'performanceMode': raw_data.get('PerformanceMode'),
            'throughputMode': raw_data.get('ThroughputMode'),
            'encrypted': raw_data.get('Encrypted'),
            'sizeInBytes': size.get('Value') if isinstance(size, dict) else None,
            'mountTargets': raw_data.get('NumberOfMountTargets'),
        })

    # RDS DB Cluster specific metadata
    elif resource_type == 'rds_db_clusters':
        metadata.update({
            'engine': raw_data.get('Engine'),
            'engineVersion': raw_data.get('EngineVersion'),
            'status': raw_data.get('Status'),
            'multiAZ': raw_data.get('MultiAZ'),
            'databaseName': raw_data.get('DatabaseName'),
            'endpoint': raw_data.get('Endpoint'),
            'readerEndpoint': raw_data.get('ReaderEndpoint'),
        })

    # CloudFront Distribution specific metadata
    elif resource_type == 'cloudfront_distributions':
        metadata.update({
            'domainName': raw_data.get('DomainName'),
            'status': raw_data.get('Status'),
            'enabled': raw_data.get('Enabled'),
            'priceClass': raw_data.get('PriceClass'),
            'comment': raw_data.get('Comment'),
            'aliases': ', '.join(raw_data.get('Aliases', {}).get('Items', []) if isinstance(raw_data.get('Aliases'), dict) else []),
        })

    # API Gateway REST API specific metadata
    elif resource_type == 'apigateway_rest_apis':
        endpoint_config = raw_data.get('endpointConfiguration', {})
        endpoint_types = endpoint_config.get('types', []) if isinstance(endpoint_config, dict) else []
        metadata.update({
            'description': raw_data.get('description'),
            'endpointType': ', '.join(endpoint_types),
            'version': raw_data.get('version'),
        })

    # SSM Parameter specific metadata
    elif resource_type == 'ssm_parameters':
        metadata.update({
            'type': raw_data.get('Type'),
            'tier': raw_data.get('Tier'),
            'dataType': raw_data.get('DataType'),
            'version': raw_data.get('Version'),
            'lastModifiedDate': str(raw_data.get('LastModifiedDate')) if raw_data.get('LastModifiedDate') else None,
        })

    # Secrets Manager specific metadata
    elif resource_type == 'secretsmanager_secrets':
        metadata.update({
            'description': raw_data.get('Description'),
            'rotationEnabled': raw_data.get('RotationEnabled'),
            'lastChangedDate': str(raw_data.get('LastChangedDate')) if raw_data.get('LastChangedDate') else None,
            'lastAccessedDate': str(raw_data.get('LastAccessedDate')) if raw_data.get('LastAccessedDate') else None,
        })

    # IAM Role specific metadata
    elif resource_type == 'iam_roles':
        metadata.update({
            'path': raw_data.get('Path'),
            'createDate': str(raw_data.get('CreateDate')) if raw_data.get('CreateDate') else None,
            'description': raw_data.get('Description'),
            'maxSessionDuration': raw_data.get('MaxSessionDuration'),
        })

    # IAM User specific metadata
    elif resource_type == 'iam_users':
        metadata.update({
            'path': raw_data.get('Path'),
            'createDate': str(raw_data.get('CreateDate')) if raw_data.get('CreateDate') else None,
            'passwordLastUsed': str(raw_data.get('PasswordLastUsed')) if raw_data.get('PasswordLastUsed') else None,
        })

    # CodePipeline specific metadata
    elif resource_type == 'codepipeline_pipelines':
        metadata.update({
            'version': raw_data.get('version'),
            'created': str(raw_data.get('created')) if raw_data.get('created') else None,
            'updated': str(raw_data.get('updated')) if raw_data.get('updated') else None,
        })

    # EKS Cluster specific metadata
    elif resource_type == 'eks_clusters':
        metadata.update({
            'version': raw_data.get('version'),
            'endpoint': raw_data.get('endpoint'),
            'platformVersion': raw_data.get('platformVersion'),
            'kubernetesNetworkConfig': raw_data.get('kubernetesNetworkConfig', {}).get('serviceIpv4Cidr') if isinstance(raw_data.get('kubernetesNetworkConfig'), dict) else None,
        })

    # CloudWatch Alarm specific metadata
    elif resource_type == 'cloudwatch_metric_alarms':
        metadata.update({
            'metricName': raw_data.get('MetricName'),
            'namespace': raw_data.get('Namespace'),
            'comparisonOperator': raw_data.get('ComparisonOperator'),
            'threshold': raw_data.get('Threshold'),
            'evaluationPeriods': raw_data.get('EvaluationPeriods'),
            'actionsEnabled': raw_data.get('ActionsEnabled'),
        })

    # EventBridge Rule specific metadata
    elif resource_type == 'events_rules':
        metadata.update({
            'scheduleExpression': raw_data.get('ScheduleExpression'),
            'eventBusName': raw_data.get('EventBusName'),
            'description': raw_data.get('Description'),
            'state': raw_data.get('State'),
        })

    # EBS Volume specific metadata
    elif resource_type == 'ec2_volumes':
        metadata.update({
            'volumeType': raw_data.get('VolumeType'),
            'size': raw_data.get('Size'),
            'iops': raw_data.get('Iops'),
            'encrypted': raw_data.get('Encrypted'),
            'availabilityZone': raw_data.get('AvailabilityZone'),
        })
    
    # ASG specific metadata
    elif resource_type == 'autoscaling_auto_scaling_groups' or resource_type == 'asg_groups':
        metadata.update({
            'minSize': raw_data.get('MinSize'),
            'maxSize': raw_data.get('MaxSize'),
            'desiredCapacity': raw_data.get('DesiredCapacity'),
            'healthCheckType': raw_data.get('HealthCheckType'),
            'availabilityZones': raw_data.get('AvailabilityZones'),
        })
    
    # EC2 Elastic IP Addresses
    elif resource_type == 'ec2_addresses':
        metadata.update({
            'publicIp': raw_data.get('PublicIp'),
            'allocationId': raw_data.get('AllocationId'),
            'associatedInstanceId': raw_data.get('InstanceId'),
            'associationId': raw_data.get('AssociationId'),
            'networkInterfaceId': raw_data.get('NetworkInterfaceId'),
            'privateIpAddress': raw_data.get('PrivateIpAddress'),
            'domain': raw_data.get('Domain'),
        })

    # ECS Services (from describe_services)
    elif resource_type == 'ecs_services':
        metadata.update({
            'clusterArn': raw_data.get('ClusterArn') or raw_data.get('clusterArn'),
            'status': raw_data.get('status') or raw_data.get('Status'),
            'desiredCount': raw_data.get('desiredCount'),
            'runningCount': raw_data.get('runningCount'),
            'pendingCount': raw_data.get('pendingCount'),
            'launchType': raw_data.get('launchType'),
            'taskDefinition': raw_data.get('taskDefinition', '').split('/')[-1] if raw_data.get('taskDefinition') else None,
        })

    # ECS Clusters (from describe_clusters)
    elif resource_type == 'ecs_clusters':
        metadata.update({
            'status': raw_data.get('status'),
            'registeredContainerInstances': raw_data.get('registeredContainerInstancesCount'),
            'runningTasksCount': raw_data.get('runningTasksCount'),
            'pendingTasksCount': raw_data.get('pendingTasksCount'),
            'activeServicesCount': raw_data.get('activeServicesCount'),
            'capacityProviders': ', '.join(raw_data.get('capacityProviders', [])) or None,
        })

    # ECS catch-all (legacy)
    elif 'ecs' in resource_type:
        metadata.update({
            'clusterArn': raw_data.get('ClusterArn') or raw_data.get('clusterArn'),
            'status': raw_data.get('Status') or raw_data.get('status'),
        })

    # Transit Gateway specific metadata
    elif resource_type == 'ec2_transit_gateways':
        metadata.update({
            'state': raw_data.get('State'),
            'ownerId': raw_data.get('OwnerId'),
            'description': raw_data.get('Description'),
            'amazonSideAsn': raw_data.get('Options', {}).get('AmazonSideAsn') if isinstance(raw_data.get('Options'), dict) else None,
            'defaultRouteTableAssociation': raw_data.get('Options', {}).get('DefaultRouteTableAssociation') if isinstance(raw_data.get('Options'), dict) else None,
            'vpnEcmpSupport': raw_data.get('Options', {}).get('VpnEcmpSupport') if isinstance(raw_data.get('Options'), dict) else None,
        })

    # Transit Gateway Attachment specific metadata
    elif resource_type == 'ec2_transit_gateway_attachments':
        metadata.update({
            'state': raw_data.get('State'),
            'resourceType': raw_data.get('ResourceType'),
            'resourceId': raw_data.get('ResourceId'),
            'resourceOwnerId': raw_data.get('ResourceOwnerId'),
            'transitGatewayId': raw_data.get('TransitGatewayId'),
            'transitGatewayOwnerId': raw_data.get('TransitGatewayOwnerId'),
        })

    # VPC Peering Connection specific metadata
    elif resource_type == 'ec2_vpc_peering_connections':
        requester = raw_data.get('RequesterVpcInfo', {})
        accepter = raw_data.get('AccepterVpcInfo', {})
        status = raw_data.get('Status', {})
        metadata.update({
            'status': status.get('Code') if isinstance(status, dict) else None,
            'requesterVpcId': requester.get('VpcId') if isinstance(requester, dict) else None,
            'requesterCidr': requester.get('CidrBlock') if isinstance(requester, dict) else None,
            'requesterOwnerId': requester.get('OwnerId') if isinstance(requester, dict) else None,
            'accepterVpcId': accepter.get('VpcId') if isinstance(accepter, dict) else None,
            'accepterCidr': accepter.get('CidrBlock') if isinstance(accepter, dict) else None,
            'accepterOwnerId': accepter.get('OwnerId') if isinstance(accepter, dict) else None,
        })

    # WAFv2 Web ACLs
    elif resource_type == 'wafv2_web_acls':
        metadata.update({
            'description': raw_data.get('Description'),
            'scope': raw_data.get('_scope'),
            'managedByFirewallManager': raw_data.get('ManagedByFirewallManager'),
            'labelNamespace': raw_data.get('LabelNamespace'),
        })
    
    # Remove None values
    return {k: v for k, v in metadata.items() if v is not None}


def _get_raw_metadata(resource: Dict[str, Any]) -> Dict[str, Any]:
    """
    Get raw metadata from the resource's rawData field.
    The rawData field contains the original AWS API response.
    
    Args:
        resource: The processed resource dictionary (contains rawData from discovery)
        
    Returns:
        Raw AWS API response data for this resource, or None
    """
    raw_data = resource.get('rawData')
    
    if not raw_data:
        return None
    
    # If rawData is already a dict, return it
    if isinstance(raw_data, dict):
        return raw_data
    
    # If rawData is a string (e.g., ARN), wrap it
    if isinstance(raw_data, str):
        return {'raw_value': raw_data}
    
    return None


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


def save_to_s3_tables(
    resources: List[Dict[str, Any]],
    s3_table_bucket_arn: str,
    s3_table_namespace: str = 'default',
    aws_region: str = 'us-east-1'
) -> int:
    """
    Write resources to AWS S3 Tables (Apache Iceberg) via the PyIceberg REST catalog.

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
        now_utc = datetime.now(timezone.utc)
        now_naive = now_utc.replace(tzinfo=None)  # Iceberg table uses TimestampType (no tz)
        rows = []
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
                'lastSeenAt': now_naive,
                'discoveryStatus': 'active',
            })

        # Match the Iceberg table schema: required fields must be non-nullable
        iceberg_schema = pa.schema([
            pa.field('resourceId',      pa.string(),                nullable=False),
            pa.field('resourceType',    pa.string(),                nullable=False),
            pa.field('name',            pa.string(),                nullable=True),
            pa.field('arn',             pa.string(),                nullable=False),
            pa.field('region',          pa.string(),                nullable=False),
            pa.field('accountId',       pa.string(),                nullable=False),
            pa.field('state',           pa.string(),                nullable=True),
            pa.field('tags',            pa.string(),                nullable=True),
            pa.field('lastSeenAt',      pa.timestamp('us'), nullable=False),
            pa.field('discoveryStatus', pa.string(),                nullable=True),
        ])
        arrow_table = pa.Table.from_pandas(pd.DataFrame(rows), schema=iceberg_schema, safe=False)

        try:
            table = catalog.load_table(table_name)
            table.append(arrow_table)
            print(f"  Appended {len(rows)} rows to S3 Table {table_name}")
        except Exception as e:
            print(f"  ERROR: S3 Table {table_name} not found or write failed: {e}")
            return 0

        return len(rows)

    except ImportError:
        print("  Skipping S3 Tables write: pyiceberg/pandas/pyarrow not installed")
        return 0
    except Exception as e:
        print(f"  ERROR writing to S3 Tables: {e}")
        return 0


def _truncate_account_inventory(
    dynamodb_client,
    table_name: str,
    account_id: str,
    tenant_id: str = 'default'
) -> int:
    """
    Delete all existing inventory records for an account before writing fresh data.
    Queries by pk (TENANT#{tenant_id}#ACCOUNT#{account_id}) and batch-deletes all INVENTORY# items.

    Returns:
        Number of items deleted
    """
    pk = f'TENANT#{tenant_id}#ACCOUNT#{account_id}'
    paginator = dynamodb_client.get_paginator('query')
    deleted = 0

    for page in paginator.paginate(
        TableName=table_name,
        KeyConditionExpression='pk = :pk AND begins_with(sk, :sk_prefix)',
        ExpressionAttributeValues={
            ':pk': {'S': pk},
            ':sk_prefix': {'S': 'INVENTORY#'},
        },
        ProjectionExpression='pk, sk',
    ):
        items = page.get('Items', [])
        if not items:
            continue

        # Batch delete in groups of 25
        for i in range(0, len(items), 25):
            batch = [
                {'DeleteRequest': {'Key': {'pk': item['pk'], 'sk': item['sk']}}}
                for item in items[i:i + 25]
            ]
            try:
                response = dynamodb_client.batch_write_item(RequestItems={table_name: batch})
                unprocessed = response.get('UnprocessedItems', {})
                retry_count = 0
                while unprocessed and retry_count < 5:
                    time.sleep(2 ** retry_count)
                    response = dynamodb_client.batch_write_item(RequestItems=unprocessed)
                    unprocessed = response.get('UnprocessedItems', {})
                    retry_count += 1
                deleted += len(batch) - len(unprocessed.get(table_name, []))
            except Exception as e:
                print(f"  ERROR deleting batch during truncate for {account_id}: {e}")

    print(f"  Truncated {deleted} existing inventory records for account {account_id}")
    return deleted


def process_and_store_resources(
    dynamodb_client,
    s3_client,
    table_name: str,
    bucket_name: str,
    account_id: str,
    account_name: str = '',
    resources: List[Dict[str, Any]] = None,
    raw_results: Dict[str, Dict[str, Any]] = None,
    tenant_id: str = 'default',
    scan_id: str = None,
    s3_table_bucket_arn: str = None,
    s3_table_namespace: str = 'default',
    aws_region: str = 'us-east-1'
) -> int:
    """
    Process resources and store in DynamoDB, S3, and optionally S3 Tables (Iceberg).

    Args:
        dynamodb_client: Boto3 DynamoDB client
        s3_client: Boto3 S3 client
        table_name: DynamoDB table name
        bucket_name: S3 bucket name
        account_id: AWS account ID
        resources: List of discovered resources (normalized)
        raw_results: Optional raw results dict for S3 storage
        s3_table_bucket_arn: Optional ARN of S3 Tables bucket for Iceberg writes
        s3_table_namespace: S3 Tables namespace (default: 'default')
        aws_region: AWS region for S3 Tables endpoint

    Returns:
        Number of resources processed
    """
    if not resources:
        return 0
    
    now = datetime.now(timezone.utc)
    timestamp = now.isoformat()
    
    # Generate scan_id if not provided
    if not scan_id:
        scan_timestamp = now.strftime('%Y%m%d%H%M%S')
        scan_id = f"SCAN#{scan_timestamp}#{uuid.uuid4().hex[:8]}"
    
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
    
    # Truncate existing inventory records for this account before writing fresh data
    if not is_pg_enabled():
        _truncate_account_inventory(dynamodb_client, table_name, account_id, tenant_id)

    # PostgreSQL-only path (USE_PG_INVENTORY=true — DynamoDB writes skipped)
    if is_pg_enabled():
        try:
            pg_count = write_resources_to_pg(resources, tenant_id, account_id)
            print(f"  [pg_writer] PostgreSQL write: {pg_count} resources for account {account_id}")
        except Exception as e:
            print(f"  [pg_writer] PostgreSQL write failed: {e}")
            raise
        total_written = pg_count
    else:
        # DynamoDB write path
        items_to_write = []

        for resource in resources:
            if not isinstance(resource, dict):
                continue
            resource_arn = generate_resource_arn(resource, account_id)
            resource_type = resource.get('resourceType', 'unknown')
            resource_id = resource.get('resourceId', 'unknown')
            name = resource.get('name', resource_id)
            region = resource.get('region', 'unknown')
            state = resource.get('state', 'unknown')
            tags = resource.get('tags', {})

            if not resource_id or resource_id == 'unknown':
                continue

            item = {
                'pk': {'S': f'TENANT#{tenant_id}#ACCOUNT#{account_id}'},
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
                'tenantId': {'S': tenant_id},
                'discoveryScanId': {'S': scan_id},
                'lastDiscoveredAt': {'S': timestamp},
                'discoveryStatus': {'S': 'active'},
            }

            if tags and isinstance(tags, dict):
                item['tags'] = {'M': {str(k): {'S': str(v)} for k, v in tags.items() if k and v}}
            if resource.get('service'):
                item['service'] = {'S': str(resource.get('service'))}
            metadata = _extract_metadata(resource, resource_type)
            if metadata:
                item['Metadata'] = {'S': json.dumps(metadata)}
            raw_data = _get_raw_metadata(resource)
            if raw_data:
                item['RawMetadata'] = {'S': json.dumps(raw_data, default=str)}

            items_to_write.append({'PutRequest': {'Item': item}})

        unique_items = {}
        for item_request in items_to_write:
            item = item_request['PutRequest']['Item']
            key = (item['pk']['S'], item['sk']['S'])
            unique_items[key] = item_request
        items_to_write = list(unique_items.values())

        batch_size = 25
        for i in range(0, len(items_to_write), batch_size):
            batch = items_to_write[i:i + batch_size]
            try:
                response = dynamodb_client.batch_write_item(RequestItems={table_name: batch})
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

    # Write normalized resources to S3 for vector processing pipeline
    # normalized/{date}/{account_id}.json triggers the vector processor Lambda via SQS
    if bucket_name and s3_client:
        _store_normalized_for_vectors(s3_client, bucket_name, account_id, account_name, resources, now)

    # S3 Tables write (Iceberg) — non-fatal
    if s3_table_bucket_arn:
        save_to_s3_tables(resources, s3_table_bucket_arn, s3_table_namespace, aws_region)

    return total_written


def _store_normalized_for_vectors(
    s3_client,
    bucket_name: str,
    account_id: str,
    account_name: str = '',
    resources: List[Dict[str, Any]] = None,
    now: datetime = None
) -> None:
    """
    Write normalized resources to S3 under the normalized/ prefix.
    This file triggers the vector processor Lambda (via SQS) to generate embeddings.
    Excludes rawData to keep the file compact.
    """
    date_folder = now.strftime('%Y%m%dT%H%M%S')
    s3_key = f"normalized/{date_folder}/{account_id}.json"

    # Serialize without rawData to keep the file small
    normalized = []
    for r in resources:
        if not isinstance(r, dict):
            continue
        item = {
            'resourceId': r.get('resourceId', ''),
            'resourceArn': r.get('resourceArn', ''),
            'resourceType': r.get('resourceType', ''),
            'name': r.get('name', ''),
            'region': r.get('region', ''),
            'state': r.get('state', ''),
            'accountId': account_id,
            'accountName': account_name,
            'service': r.get('service', ''),
            'tags': r.get('tags', {}),
            'metadata': _extract_metadata(r, r.get('resourceType', '')),
            'lastDiscoveredAt': now.isoformat(),
            'discoveryStatus': 'active',
        }
        normalized.append(item)

    try:
        s3_client.put_object(
            Bucket=bucket_name,
            Key=s3_key,
            Body=json.dumps(normalized, cls=DateTimeEncoder),
            ContentType='application/json'
        )
        print(f"  Stored {len(normalized)} normalized resources to s3://{bucket_name}/{s3_key}")
    except Exception as e:
        print(f"  WARNING: Failed to write normalized file to S3: {e}")


def save_sync_status(
    dynamodb_client,
    app_table_name: str,
    scan_id: str,
    total_resources: int,
    accounts_synced: int = 1
) -> bool:
    """
    Save sync status metadata to APP_TABLE for the status endpoint.
    
    Args:
        dynamodb_client: Boto3 DynamoDB client
        app_table_name: APP_TABLE name
        scan_id: The unique scan ID for this run
        total_resources: Total count of resources discovered
        accounts_synced: Number of accounts scanned
        
    Returns:
        True if successful, False otherwise
    """
    now = datetime.now(timezone.utc)
    timestamp = now.isoformat()
    
    try:
        dynamodb_client.put_item(
            TableName=app_table_name,
            Item={
                'pk': {'S': 'SYNC#INVENTORY'},
                'sk': {'S': scan_id},
                'scanId': {'S': scan_id},
                'totalResources': {'N': str(total_resources)},
                'accountsSynced': {'N': str(accounts_synced)},
                'syncedAt': {'S': timestamp},
                'status': {'S': 'completed'},
            }
        )
        print(f"  Saved sync status: {total_resources} resources, {accounts_synced} accounts")
        return True
    except Exception as e:
        print(f"  ERROR saving sync status: {e}")
        return False


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
            ':pk': {'S': f'TENANT#default#ACCOUNT#{account_id}'},
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
                        'pk': {'S': f'TENANT#default#ACCOUNT#{account_id}'},
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
