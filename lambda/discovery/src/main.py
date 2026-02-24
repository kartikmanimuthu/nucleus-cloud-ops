"""
AWS Auto-Discovery ECS Fargate Task
Main entry point for discovering AWS resources across multi-account environments.
Uses parallel scanning with ThreadPoolExecutor for high performance.
"""
import os
import sys
import json
import boto3
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

try:
    from src.config_generator import generate_inventory_config, load_scanfile
    from src.inventory_runner import run_inventory_scan
    from src.data_processor import (
        process_and_store_resources,
        mark_missing_resources,
        get_discovered_arns,
        store_merged_to_s3,
        save_sync_status
    )
    from src.audit_logger import create_audit_log
except ImportError:
    from config_generator import generate_inventory_config, load_scanfile
    from inventory_runner import run_inventory_scan
    from data_processor import (
        process_and_store_resources,
        mark_missing_resources,
        get_discovered_arns,
        store_merged_to_s3,
        save_sync_status
    )
    from audit_logger import create_audit_log


def get_active_accounts(dynamodb_client, table_name: str) -> List[Dict[str, Any]]:
    """Fetch all active accounts from DynamoDB."""
    accounts = []
    paginator = dynamodb_client.get_paginator('query')
    
    for page in paginator.paginate(
        TableName=table_name,
        IndexName='GSI1',
        KeyConditionExpression='gsi1pk = :pk',
        ExpressionAttributeValues={
            ':pk': {'S': 'TYPE#ACCOUNT'},
            ':active': {'BOOL': True}
        },
        FilterExpression='#active = :active',
        ExpressionAttributeNames={'#active': 'active'},
    ):
        for item in page.get('Items', []):
            # Handle both formats: DDB low-level and resource-level
            accounts.append({
                'accountId': item.get('accountId', item.get('account_id', {})).get('S', ''),
                'accountName': item.get('accountName', item.get('account_name', {})).get('S', ''),
                'roleArn': item.get('roleArn', item.get('role_arn', {})).get('S', ''),
                'externalId': item.get('externalId', item.get('external_id', {})).get('S', ''),
                'regions': extract_regions(item.get('regions', {})),
            })
    
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


def update_account_sync_status(
    dynamodb_client,
    table_name: str,
    account_id: str,
    status: str,
    resource_count: int,
    duration_ms: int
) -> None:
    """Update the sync status for an account."""
    try:
        dynamodb_client.update_item(
            TableName=table_name,
            Key={
                'pk': {'S': f'ACCOUNT#{account_id}'},
                'sk': {'S': 'METADATA'}
            },
            UpdateExpression='SET lastSyncedAt = :ts, lastSyncStatus = :status, lastSyncResourceCount = :count, lastSyncDurationMs = :duration',
            ExpressionAttributeValues={
                ':ts': {'S': datetime.now(timezone.utc).isoformat()},
                ':status': {'S': status},
                ':count': {'N': str(resource_count)},
                ':duration': {'N': str(duration_ms)}
            }
        )
    except Exception as e:
        print(f"WARNING: Failed to update sync status for {account_id}: {e}")


def main():
    """Main entry point for the discovery task."""
    print("=" * 60)
    print("AWS Auto-Discovery Task Starting")
    print(f"Time: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 60)
    
    # Environment variables
    app_table_name = os.environ.get('APP_TABLE_NAME')
    audit_table_name = os.environ.get('AUDIT_TABLE_NAME')
    inventory_table_name = os.environ.get('INVENTORY_TABLE_NAME')
    inventory_bucket = os.environ.get('INVENTORY_BUCKET')
    specific_account_id = os.environ.get('ACCOUNT_ID')  # Optional: scan specific account
    scanfile_path = os.environ.get('SCANFILE_PATH')  # Optional: custom scanfile
    scan_id = os.environ.get('SCAN_ID')
    if not scan_id:
        scan_id = f"SCAN#{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    correlation_id = os.environ.get('CORRELATION_ID')
    
    # Concurrency settings
    concurrent_regions = int(os.environ.get('CONCURRENT_REGIONS', '5'))
    concurrent_services = int(os.environ.get('CONCURRENT_SERVICES', '10'))
    
    if not app_table_name:
        print("ERROR: APP_TABLE_NAME environment variable is required")
        sys.exit(1)
    
    if not inventory_table_name:
        print("ERROR: INVENTORY_TABLE_NAME environment variable is required")
        sys.exit(1)
    
    if not inventory_bucket:
        print("ERROR: INVENTORY_BUCKET environment variable is required")
        sys.exit(1)
    
    print(f"Configuration:")
    print(f"  APP_TABLE_NAME: {app_table_name}")
    print(f"  INVENTORY_TABLE_NAME: {inventory_table_name}")
    print(f"  INVENTORY_BUCKET: {inventory_bucket}")
    print(f"  CONCURRENT_REGIONS: {concurrent_regions}")
    print(f"  CONCURRENT_SERVICES: {concurrent_services}")
    
    # Initialize AWS clients
    dynamodb = boto3.client('dynamodb')
    s3 = boto3.client('s3')
    
    # Get accounts to scan
    if specific_account_id:
        print(f"\nScanning specific account: {specific_account_id}")
        # Fetch single account details or use minimal config
        accounts = [{'accountId': specific_account_id}]
    else:
        print("\nFetching all active accounts...")
        accounts = get_active_accounts(dynamodb, app_table_name)
    
    print(f"Found {len(accounts)} account(s) to scan")
    
    if not accounts:
        print("No accounts to scan. Exiting.")
        return
    
    # Track all raw results for merged output
    all_accounts_data = {}
    total_resources = 0
    successful_accounts = 0
    failed_accounts = 0
    
    for account in accounts:
        account_id = account.get('accountId')
        account_name = account.get('accountName', account_id)
        role_arn = account.get('roleArn')
        external_id = account.get('externalId')
        
        if not account_id:
            print("WARN: Skipping account with no accountId")
            continue
        
        print(f"\n{'=' * 40}")
        print(f"Scanning Account: {account_name} ({account_id})")
        print(f"{'=' * 40}")
        start_time = datetime.now(timezone.utc)
        
        try:
            # Generate config for this account
            config = generate_inventory_config(account, scanfile_path)
            
            # Run the parallel inventory scan
            scan_result = run_inventory_scan(
                config,
                role_arn=role_arn,
                external_id=external_id,
                concurrent_regions=concurrent_regions,
                concurrent_services=concurrent_services
            )
            
            resources = scan_result.get('resources', [])
            raw_results = scan_result.get('raw_results', {})
            
            # Store raw results for merged output
            all_accounts_data[account_id] = raw_results
            
            # Process and store results
            resource_count = process_and_store_resources(
                dynamodb_client=dynamodb,
                s3_client=s3,
                table_name=inventory_table_name,
                bucket_name=inventory_bucket,
                account_id=account_id,
                resources=resources,
                raw_results=raw_results,
                scan_id=scan_id
            )
            
            # Mark missing resources
            discovered_arns = get_discovered_arns(resources, account_id)
            mark_missing_resources(dynamodb, inventory_table_name, account_id, discovered_arns)
            
            # Calculate duration
            end_time = datetime.now(timezone.utc)
            duration_ms = int((end_time - start_time).total_seconds() * 1000)
            
            # Update sync status
            update_account_sync_status(
                dynamodb, app_table_name, account_id,
                'success', resource_count, duration_ms
            )
            
            total_resources += resource_count
            successful_accounts += 1
            
            # Update global sync status
            save_sync_status(
                dynamodb, app_table_name, scan_id, 
                total_resources, successful_accounts
            )
            print(f"\nSUCCESS: Discovered {resource_count} resources in {duration_ms}ms")
            print(f"  Regions: {scan_result.get('regions_scanned', 0)}")
            print(f"  Services: {scan_result.get('services_scanned', 0)}")
            print(f"  Elapsed: {scan_result.get('elapsed_seconds', 0):.1f}s")
            
        except Exception as e:
            print(f"\nERROR scanning account {account_id}: {str(e)}")
            import traceback
            traceback.print_exc()
            failed_accounts += 1
            
            # Update sync status as failed
            end_time = datetime.now(timezone.utc)
            duration_ms = int((end_time - start_time).total_seconds() * 1000)
            update_account_sync_status(
                dynamodb, app_table_name, account_id,
                'failed', 0, duration_ms
            )
    
    # Create merged output across all accounts
    if all_accounts_data:
        print("\n" + "-" * 40)
        print("Creating merged output...")
        timestamp = datetime.now(timezone.utc).isoformat()
        store_merged_to_s3(s3, inventory_bucket, all_accounts_data, timestamp)
    
    print("\n" + "=" * 60)
    print("AWS Auto-Discovery Task Complete")
    print("=" * 60)
    print(f"Total Accounts: {len(accounts)}")
    print(f"Successful: {successful_accounts}")
    print(f"Failed: {failed_accounts}")
    print(f"Total Resources: {total_resources}")
    print("=" * 60)

    # Generate Audit Log for Scan Completion
    status = 'success' if failed_accounts == 0 else ('warning' if successful_accounts > 0 else 'error')
    details = f"Discovery scan completed. Scanned {len(accounts)} accounts. Found {total_resources} resources."
    if failed_accounts > 0:
        details += f" Failed accounts: {failed_accounts}."

    create_audit_log(
        dynamodb_client=dynamodb,
        table_name=audit_table_name,
        event_type='discovery.scan.completed',
        action='scan_completed',
        status=status,
        resource=f"Scan {scan_id}" if scan_id else "Manual Discovery Scan",
        details=details,
        metadata={
            'totalAccounts': len(accounts),
            'successfulAccounts': successful_accounts,
            'failedAccounts': failed_accounts,
            'totalResources': total_resources,
            'regionsScanned': concurrent_regions
        },
        scan_id=scan_id,
        correlation_id=correlation_id
    )


    # Determine exit code based on success
    if failed_accounts > 0:
        print(f"WARNING: {failed_accounts} accounts failed to scan.")
        # We exit with 0 even if some accounts failed, because the job ran to completion.
        # But if user wants error on ANY failure, we could use 1.
        # Given "exit the container on success or on error as well", exit(0) is safer for success
        # unless it's a critical failure. However, let's stick to standard practice:
        # Partial success is often still success for a batch job unless completely failed.
        sys.exit(0)
    else:
        sys.exit(0)
if __name__ == '__main__':
    main()
