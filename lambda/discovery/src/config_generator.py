"""
Configuration Generator for AWS Auto Inventory.
Generates configuration for scanning resources with support for JSON-based scanfiles.
"""
import json
import os
from typing import Dict, Any, List, Optional


# Default regions to scan
DEFAULT_REGIONS = [
    'us-east-1',
    'us-west-2',
    'eu-west-1',
    'ap-south-1',
]

# Path to default scanfile
DEFAULT_SCANFILE = os.path.join(os.path.dirname(__file__), 'scanfile.json')


def load_scanfile(scanfile_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Load scan configuration from JSON file.
    
    Args:
        scanfile_path: Path to JSON scanfile, uses default if not provided
        
    Returns:
        List of service configurations
    """
    path = scanfile_path or DEFAULT_SCANFILE
    
    try:
        with open(path, 'r') as f:
            services = json.load(f)
        return services
    except FileNotFoundError:
        print(f"Scanfile not found: {path}, using default services")
        return get_default_services()
    except json.JSONDecodeError as e:
        print(f"Invalid JSON in scanfile {path}: {e}")
        return get_default_services()


def get_default_services() -> List[Dict[str, Any]]:
    """Return default list of services to scan."""
    return [
        # Compute Resources
        {'name': 'EC2Instances', 'service': 'ec2', 'function': 'describe_instances', 'result_key': 'Reservations'},
        {'name': 'LambdaFunctions', 'service': 'lambda', 'function': 'list_functions', 'result_key': 'Functions'},
        {'name': 'ECSClusters', 'service': 'ecs', 'function': 'list_clusters', 'result_key': 'clusterArns'},
        {'name': 'AutoScalingGroups', 'service': 'autoscaling', 'function': 'describe_auto_scaling_groups', 'result_key': 'AutoScalingGroups'},
        
        # Database Resources
        {'name': 'RDSInstances', 'service': 'rds', 'function': 'describe_db_instances', 'result_key': 'DBInstances'},
        {'name': 'RDSClusters', 'service': 'rds', 'function': 'describe_db_clusters', 'result_key': 'DBClusters'},
        {'name': 'DocumentDBClusters', 'service': 'docdb', 'function': 'describe_db_clusters', 'result_key': 'DBClusters'},
        {'name': 'DynamoDBTables', 'service': 'dynamodb', 'function': 'list_tables', 'result_key': 'TableNames'},
        
        # Storage Resources
        {'name': 'S3Buckets', 'service': 's3', 'function': 'list_buckets', 'result_key': 'Buckets'},
        {'name': 'EBSVolumes', 'service': 'ec2', 'function': 'describe_volumes', 'result_key': 'Volumes'},
        {'name': 'EFSFilesystems', 'service': 'efs', 'function': 'describe_file_systems', 'result_key': 'FileSystems'},
        
        # Networking Resources
        {'name': 'VPCs', 'service': 'ec2', 'function': 'describe_vpcs', 'result_key': 'Vpcs'},
        {'name': 'Subnets', 'service': 'ec2', 'function': 'describe_subnets', 'result_key': 'Subnets'},
        {'name': 'LoadBalancers', 'service': 'elbv2', 'function': 'describe_load_balancers', 'result_key': 'LoadBalancers'},
        {'name': 'NATGateways', 'service': 'ec2', 'function': 'describe_nat_gateways', 'result_key': 'NatGateways'},
        
        # Security Resources
        {'name': 'SecurityGroups', 'service': 'ec2', 'function': 'describe_security_groups', 'result_key': 'SecurityGroups'},
        {'name': 'KMSKeys', 'service': 'kms', 'function': 'list_keys', 'result_key': 'Keys'},
    ]


def generate_inventory_config(
    account: Dict[str, Any],
    scanfile_path: Optional[str] = None
) -> Dict[str, Any]:
    """
    Generate AWS Auto Inventory configuration for an account.
    
    Args:
        account: Account details including accountId, roleArn, regions
        scanfile_path: Optional path to custom scanfile
        
    Returns:
        Configuration dictionary for AWS Auto Inventory
    """
    account_id = account.get('accountId', 'unknown')
    regions = account.get('regions', DEFAULT_REGIONS)
    
    # If regions is a list of DynamoDB items, extract the strings
    if regions and isinstance(regions[0], dict) and 'S' in regions[0]:
        regions = [r.get('S', 'us-east-1') for r in regions]
    
    # Load services from scanfile
    services = load_scanfile(scanfile_path)
    
    config = {
        'inventories': [
            {
                'name': f'nucleus-discovery-{account_id}',
                'aws': {
                    'profile': None,  # Uses ECS task role / assumed role
                    'region': regions,
                    'organization': False,
                },
                'sheets': services,
            }
        ]
    }
    
    return config


def generate_direct_config(
    regions: List[str],
    scanfile_path: Optional[str] = None
) -> Dict[str, Any]:
    """
    Generate configuration for direct scanning (no account wrapping).
    
    Args:
        regions: List of AWS regions to scan
        scanfile_path: Optional path to custom scanfile
        
    Returns:
        Configuration dictionary
    """
    services = load_scanfile(scanfile_path)
    
    return {
        'inventories': [
            {
                'name': 'nucleus-discovery',
                'aws': {'region': regions},
                'sheets': services,
            }
        ]
    }


def save_config_to_json(config: Dict[str, Any], filepath: str) -> None:
    """Save configuration to a JSON file."""
    with open(filepath, 'w') as f:
        json.dump(config, f, indent=2)
