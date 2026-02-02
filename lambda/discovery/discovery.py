import boto3
import os
import logging
import json
import uuid
from botocore.exceptions import ClientError
from datetime import datetime, timezone

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

class DiscoveryService:
    def __init__(self):
        self.app_table_name = os.environ.get('APP_TABLE_NAME')
        self.inventory_table_name = os.environ.get('INVENTORY_TABLE_NAME')
        self.aws_region = os.environ.get('AWS_REGION', 'ap-south-1')
        
        if not self.app_table_name or not self.inventory_table_name:
            raise ValueError("Environment variables APP_TABLE_NAME and INVENTORY_TABLE_NAME must be set")

        self.dynamodb = boto3.resource('dynamodb', region_name=self.aws_region)
        self.app_table = self.dynamodb.Table(self.app_table_name)
        self.inventory_table = self.dynamodb.Table(self.inventory_table_name)
        self.sts_client = boto3.client('sts', region_name=self.aws_region)

    def get_active_accounts(self):
        """Fetch all active accounts from DynamoDB"""
        try:
            response = self.app_table.query(
                IndexName='GSI1',
                KeyConditionExpression=boto3.dynamodb.conditions.Key('gsi1pk').eq('TYPE#ACCOUNT')
            )
            accounts = response.get('Items', [])
            
            # Filter for active accounts
            active_accounts = [acc for acc in accounts if acc.get('active') is True]
            logger.info(f"Found {len(active_accounts)} active accounts out of {len(accounts)} total.")
            return active_accounts
        except ClientError as e:
            logger.error(f"Error fetching accounts: {e}")
            raise

    def assume_role(self, role_arn, external_id=None, session_name='NucleusDiscovery'):
        """Assume role in target account"""
        try:
            params = {
                'RoleArn': role_arn,
                'RoleSessionName': session_name
            }
            if external_id:
                params['ExternalId'] = external_id

            response = self.sts_client.assume_role(**params)
            creds = response['Credentials']
            
            return {
                'aws_access_key_id': creds['AccessKeyId'],
                'aws_secret_access_key': creds['SecretAccessKey'],
                'aws_session_token': creds['SessionToken']
            }
        except ClientError as e:
            logger.error(f"Error assuming role {role_arn}: {e}")
            return None

    def scan_account(self, account):
        """Scan resources in the given account"""
        account_id = account.get('accountId') or account.get('sk').replace('ACCOUNT#', '')
        role_arn = account.get('roleArn')
        external_id = account.get('externalId')
        regions = account.get('regions', [self.aws_region]) # Default to current region if not specified
        
        logger.info(f"Scanning account {account_id} ({account.get('accountName')})")
        
        creds = self.assume_role(role_arn, external_id)
        if not creds:
            logger.warning(f"Skipping account {account_id} due to assume role failure")
            return []

        all_resources = []
        
        for region in regions:
            logger.info(f"Scanning region {region} for account {account_id}")
            try:
                # Initialize clients
                ec2 = boto3.client('ec2', region_name=region, **creds)
                rds = boto3.client('rds', region_name=region, **creds)
                ecs = boto3.client('ecs', region_name=region, **creds)
                asg = boto3.client('autoscaling', region_name=region, **creds)

                # 1. Scan EC2
                paginator = ec2.get_paginator('describe_instances')
                for page in paginator.paginate():
                    for reservation in page.get('Reservations', []):
                        for instance in reservation.get('Instances', []):
                            if instance['State']['Name'] == 'terminated':
                                continue
                            
                            tags = {t['Key']: t['Value'] for t in instance.get('Tags', [])}
                            
                            # Skip ASG instances (managed by ASG)
                            if 'aws:autoscaling:groupName' in tags:
                                continue

                            all_resources.append({
                                'resourceId': instance['InstanceId'],
                                'resourceType': 'ec2_instances',
                                'name': tags.get('Name', instance['InstanceId']),
                                'arn': f"arn:aws:ec2:{region}:{account_id}:instance/{instance['InstanceId']}", # Construct ARN manually if missing
                                'region': region,
                                'state': instance['State']['Name'],
                                'tags': tags,
                                'accountId': account_id
                            })

                # 2. Scan RDS
                paginator = rds.get_paginator('describe_db_instances')
                for page in paginator.paginate():
                    for db in page.get('DBInstances', []):
                        # Skip DocDB (engine='docdb')
                        if db['Engine'] == 'docdb':
                            continue
                            
                        all_resources.append({
                            'resourceId': db['DBInstanceIdentifier'],
                            'resourceType': 'rds_instances',
                            'name': db['DBInstanceIdentifier'],
                            'arn': db['DBInstanceArn'],
                            'region': region,
                            'state': db['DBInstanceStatus'],
                            'tags': {t['Key']: t['Value'] for t in db.get('TagList', [])}, # RDS tags might need separate call if not in response
                            'accountId': account_id
                        })
                
                # Scan DocDB Clusters
                paginator = rds.get_paginator('describe_db_clusters')
                for page in paginator.paginate(Filters=[{'Name': 'engine', 'Values': ['docdb']}]):
                    for cluster in page.get('DBClusters', []):
                        all_resources.append({
                            'resourceId': cluster['DBClusterIdentifier'],
                            'resourceType': 'docdb_instances',
                            'name': cluster['DBClusterIdentifier'],
                            'arn': cluster['DBClusterArn'],
                            'region': region,
                            'state': cluster['Status'],
                            'tags': {t['Key']: t['Value'] for t in cluster.get('TagList', [])},
                            'accountId': account_id
                        })

                # 3. Scan ECS Services
                paginator = ecs.get_paginator('list_clusters')
                cluster_arns = []
                for page in paginator.paginate():
                    cluster_arns.extend(page.get('clusterArns', []))
                
                for cluster_arn in cluster_arns:
                    cluster_name = cluster_arn.split('/')[-1]
                    list_svc_paginator = ecs.get_paginator('list_services')
                    service_arns = []
                    for svc_page in list_svc_paginator.paginate(cluster=cluster_arn):
                        service_arns.extend(svc_page.get('serviceArns', []))
                    
                    # Describe services in batches of 10
                    for i in range(0, len(service_arns), 10):
                        batch = service_arns[i:i+10]
                        if not batch: continue
                        
                        resp = ecs.describe_services(cluster=cluster_arn, services=batch)
                        for svc in resp.get('services', []):
                            all_resources.append({
                                'resourceId': svc['serviceName'],
                                'resourceType': 'ecs_services',
                                'name': f"{cluster_name}/{svc['serviceName']}",
                                'arn': svc['serviceArn'],
                                'region': region,
                                'state': svc['status'],
                                'tags': {t['Key']: t['Value'] for t in svc.get('tags', [])},
                                'accountId': account_id,
                                'metadata': {'clusterArn': cluster_arn}
                            })

                # 4. Scan ASG
                paginator = asg.get_paginator('describe_auto_scaling_groups')
                for page in paginator.paginate():
                    for group in page.get('AutoScalingGroups', []):
                        all_resources.append({
                            'resourceId': group['AutoScalingGroupName'],
                            'resourceType': 'asg_groups',
                            'name': group['AutoScalingGroupName'],
                            'arn': group['AutoScalingGroupARN'],
                            'region': region,
                            'state': 'active', # ASG doesn't have a simple state like started/stopped
                            'tags': {t['Key']: t['Value'] for t in group.get('Tags', [])},
                            'accountId': account_id
                        })

            except Exception as e:
                logger.error(f"Error scanning region {region} for account {account_id}: {e}")
                # Continue to next region
                continue

        return all_resources

    def save_resources(self, resources, scan_id):
        """Save discovered resources to DynamoDB with new schema structure"""
        if not resources:
            return

        logger.info(f"Saving {len(resources)} resources to Inventory (Scan ID: {scan_id})")
        
        # Tenant ID defaults to 'default' for now (multi-tenant ready)
        tenant_id = 'default'
        
        with self.inventory_table.batch_writer() as batch:
            for res in resources:
                now = datetime.now(timezone.utc).isoformat()
                resource_type = res['resourceType']  # e.g., ec2_instances, rds_instances
                
                item = {
                    # Primary key: TENANT#<tenantId>#ACCOUNT#<accountId>
                    'pk': f"TENANT#{tenant_id}#ACCOUNT#{res['accountId']}",
                    # Sort key: INVENTORY#<resourceType>#<arn>
                    'sk': f"INVENTORY#{resource_type}#{res['arn']}",
                    
                    # GSI1: Query all inventory items - TYPE#INVENTORY -> {resourceType}#{region}#{name}
                    'gsi1pk': 'TYPE#INVENTORY',
                    'gsi1sk': f"{resource_type}#{res['region']}#{res['name']}",
                    
                    # GSI2: Query by region - REGION#{region} -> {resourceType}#{timestamp}
                    'gsi2pk': f"REGION#{res['region']}",
                    'gsi2sk': f"{resource_type}#{now}",
                    
                    # GSI3: Query by resource type - RESOURCE_TYPE#{resourceType} -> {accountId}#{resourceId}
                    'gsi3pk': f"RESOURCE_TYPE#{resource_type}",
                    'gsi3sk': f"{res['accountId']}#{res['resourceId']}",
                    
                    # Resource attributes
                    'resourceId': res['resourceId'],
                    'resourceArn': res['arn'],
                    'resourceType': resource_type,
                    'name': res['name'],
                    'region': res['region'],
                    'accountId': res['accountId'],
                    'state': res['state'],
                    'tags': res.get('tags', {}),
                    
                    # Discovery tracking
                    'tenantId': tenant_id,
                    'discoveryScanId': scan_id,
                    'lastDiscoveredAt': now,
                    'discoveryStatus': 'active'
                }
                
                # Add Metadata (structured resource-specific data)
                if 'metadata' in res:
                    item['Metadata'] = res['metadata']
                
                # Add RawMetadata (full API response for future use)
                if 'rawMetadata' in res:
                    item['RawMetadata'] = res['rawMetadata']
                    
                batch.put_item(Item=item)

    def run(self):
        """Main execution flow"""
        logger.info("Starting Auto Discovery...")
        
        # Generate unique scan ID for this discovery run
        scan_timestamp = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
        scan_id = f"SCAN#{scan_timestamp}#{uuid.uuid4().hex[:8]}"
        logger.info(f"Discovery Scan ID: {scan_id}")
        
        accounts = self.get_active_accounts()
        
        total_resources = 0
        all_resources = []
        synced_accounts = []
        
        for account in accounts:
            resources = self.scan_account(account)
            self.save_resources(resources, scan_id)  # Pass scan_id
            all_resources.extend(resources)
            total_resources += len(resources)
            synced_accounts.append(account.get('accountId', 'unknown'))
        
        # Write all resources to S3 Table (Iceberg) at once (or in batches)
        self.save_to_s3_table(all_resources)
        
        # Save sync metadata to app_table for status tracking
        self._save_sync_status(scan_id, total_resources, len(synced_accounts))

        logger.info(f"Auto Discovery Completed. Total resources synced: {total_resources}")
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': f"Synced {total_resources} resources",
                'scanId': scan_id,
                'resourceCount': total_resources,
                'accountsSynced': len(synced_accounts)
            })
        }
    
    def _save_sync_status(self, scan_id, total_resources, accounts_synced):
        """Save sync status metadata to app_table for UI status tracking"""
        try:
            now = datetime.now(timezone.utc).isoformat()
            self.app_table.put_item(
                Item={
                    'pk': 'SYNC#INVENTORY',
                    'sk': scan_id,
                    'gsi1pk': 'TYPE#SYNC',
                    'gsi1sk': f"INVENTORY#{now}",
                    'scanId': scan_id,
                    'totalResources': total_resources,
                    'accountsSynced': accounts_synced,
                    'syncedAt': now,
                    'status': 'completed'
                }
            )
            logger.info(f"Saved sync status: {scan_id}, resources: {total_resources}, accounts: {accounts_synced}")
        except Exception as e:
            logger.error(f"Error saving sync status: {e}")

    def save_to_s3_table(self, resources):
        """Save resources to S3 Table (Iceberg)"""
        s3_table_bucket = os.environ.get('S3_TABLE_BUCKET_ARN')
        s3_table_namespace = os.environ.get('S3_TABLE_NAMESPACE', 'default') # Default to 'default' namespace which is created with bucket
        
        if not s3_table_bucket:
            logger.warning("Skipping S3 Table sync: S3_TABLE_BUCKET_ARN not set")
            return

        if not resources:
            logger.info("No resources to save to S3 Table")
            return

        try:
            import pandas as pd
            import pyarrow as pa
            from pyiceberg.catalog import load_catalog
            from pyiceberg.schema import Schema
            from pyiceberg.types import NestedField, StringType, TimestampType
            
            logger.info(f"Writing {len(resources)} resources to S3 Table in bucket {s3_table_bucket}...")
            
            # 1. Prepare Data
            rows = []
            for res in resources:
                rows.append({
                    'resourceId': res['resourceId'],
                    'resourceType': res['resourceType'],
                    'name': res['name'],
                    'arn': res['arn'],
                    'region': res['region'],
                    'accountId': res['accountId'],
                    'state': res['state'],
                    'tags': json.dumps(res.get('tags', {})),
                    'lastSeenAt': datetime.now(timezone.utc),
                    'discoveryStatus': 'active'
                })
            
            df = pd.DataFrame(rows)
            
            # 2. Configure Catalog
            # Use 'glue' type if we are using Glue Catalog for S3 Tables, or check correct S3Tables integration
            # For S3 Tables proper, we might need a specific catalog implementation or 'glue' works if integrated.
            catalog = load_catalog("default", **{
                "type": "glue", 
                "s3.region": self.aws_region
            })
            
            table_name = f"{s3_table_namespace}.resources"
            
            try:
                table = catalog.load_table(table_name)
                logger.info(f"Loaded Iceberg table {table_name}")
                
                # Append data
                table.append(pa.Table.from_pandas(df))
                logger.info("Successfully wrote data to S3 Table")
                
            except Exception as e:
                logger.error(f"Failed to load or write to Iceberg table {table_name}: {e}")
                
        except ImportError:
            logger.error("Skipping S3 Table sync: Required libraries (pyiceberg, pandas, pyarrow) not installed")
        except Exception as e:
            logger.error(f"Error executing S3 Table sync: {e}", exc_info=True)

def handler(event, context):
    service = DiscoveryService()
    return service.run()
