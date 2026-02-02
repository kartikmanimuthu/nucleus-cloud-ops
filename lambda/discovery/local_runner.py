"""
Local Runner for testing discovery module.
Supports:
1. Direct Scan: Scan using current credentials/role with CLI overrides (regions, services).
2. Orchestrated Scan: Fetch accounts from DynamoDB and scan all or specific accounts.
"""
import argparse
import json
import os
import sys
import boto3
import time
from datetime import datetime, timezone

# Add src to path if running from lambda/discovery
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

# Support running directly or as module
try:
    from src.config_generator import generate_inventory_config, generate_direct_config, load_scanfile
    from src.inventory_runner import run_inventory_scan
    from src.main import get_active_accounts
    from src.data_processor import (
        process_and_store_resources,
        mark_missing_resources, 
        get_discovered_arns,
        store_merged_to_s3,
        save_sync_status
    )
except ImportError:
    from config_generator import generate_inventory_config, generate_direct_config, load_scanfile
    from inventory_runner import run_inventory_scan
    from main import get_active_accounts
    from data_processor import (
        process_and_store_resources,
        mark_missing_resources, 
        get_discovered_arns,
        store_merged_to_s3,
        save_sync_status
    )


def main():
    parser = argparse.ArgumentParser(description='Run AWS resource discovery locally')
    
    # Scanning Mode Arguments
    parser.add_argument('--all-accounts', action='store_true', help='Scan all active accounts from DynamoDB')
    parser.add_argument('--account-id', type=str, help='Scan specific account ID (fetched from DynamoDB)')
    
    # Infrastructure Arguments (ENV vars as defaults)
    parser.add_argument('--app-table', type=str, default=os.environ.get('APP_TABLE_NAME'), help='App Table Name (for fetching accounts and saving sync status)')
    parser.add_argument('--inventory-table', type=str, default=os.environ.get('INVENTORY_TABLE_NAME'), help='Inventory Table Name (for persistence)')
    parser.add_argument('--bucket', type=str, default=os.environ.get('INVENTORY_BUCKET'), help='Inventory S3 Bucket (for persistence)')
    
    # Override Arguments
    parser.add_argument('--regions', nargs='+', help='Override regions to scan')
    parser.add_argument('--role-arn', type=str, help='Override Role ARN (Direct mode only)')
    parser.add_argument('--scanfile', type=str, help='Path to custom scanfile JSON')
    
    # Concurrency
    parser.add_argument('--concurrent-regions', type=int, default=3, help='Concurrent regions')
    parser.add_argument('--concurrent-services', type=int, default=5, help='Concurrent services per region')
    
    # Output/Debug
    parser.add_argument('--output', type=str, help='Output file for results (JSON) - Direct mode only')
    parser.add_argument('--verbose', action='store_true', help='Enable verbose output')
    parser.add_argument('--list-services', action='store_true', help='List configured services and exit')
    
    args = parser.parse_args()
    
    # --- Service Listing ---
    if args.list_services:
        services = load_scanfile(args.scanfile)
        print(f"Configured services ({len(services)}):")
        for svc in services:
            print(f"  {svc['service']}.{svc['function']}")
        return

    print("=" * 60)
    print("AWS Auto-Discovery Local Runner")
    print("=" * 60)

    # Initialize Clients
    dynamodb = boto3.client('dynamodb') if args.app_table or args.inventory_table or args.all_accounts or args.account_id else None
    s3 = boto3.client('s3') if args.bucket else None

    # --- Mode Selection ---
    accounts_to_scan = []

    if args.all_accounts or args.account_id:
        # ORCHESTRATED MODE
        if not args.app_table:
            print("ERROR: --app-table is required for account scanning.")
            sys.exit(1)
        
        print(f"Fetching accounts from {args.app_table}...")
        all_accounts = get_active_accounts(dynamodb, args.app_table)
        
        if args.account_id:
            accounts_to_scan = [a for a in all_accounts if a['accountId'] == args.account_id]
            if not accounts_to_scan:
                print(f"Account {args.account_id} not found in DynamoDB or not active.")
                # Fallback: create ad-hoc account object if not found but requested?
                # For partial testing, maybe we want this. But safer to exit.
                sys.exit(1)
        else:
            accounts_to_scan = all_accounts
            
        print(f"Found {len(accounts_to_scan)} account(s) to scan.")
        
    else:
        # DIRECT MODE
        if not args.regions:
            # Default regions if not specified
            args.regions = ['ap-south-1']
            
        # Create a dummy account object for direct scanning
        accounts_to_scan = [{
            'accountId': 'direct-scan',
            'roleArn': args.role_arn, # Can be None (current creds)
            'regions': args.regions
        }]
        print("Running in DIRECT MODE (Current Credentials)")

    # --- Execution Loop ---
    all_results_data = {}
    
    for account in accounts_to_scan:
        acc_id = account.get('accountId')
        role_arn = account.get('roleArn')
        regions = account.get('regions', [])
        
        # Override regions if provided in CLI
        if args.regions:
            regions = args.regions
            account['regions'] = regions
        
        print(f"\nScanning Account: {acc_id}")
        print(f"  Role: {role_arn or 'Current Session'}")
        print(f"  Regions: {regions}")
        
        # Generate Config
        if 'api_config' in account: # If strictly from main.py structure
             config = generate_inventory_config(account, args.scanfile)
        else:
             # Hybrid/Direct structure
             config = generate_inventory_config(account, args.scanfile)
             # Force regions override in config if needed
             if args.regions:
                 config['inventories'][0]['aws']['region'] = args.regions

        # Run Scan
        start_time = time.time()
        result = run_inventory_scan(
            config,
            role_arn=role_arn,
            concurrent_regions=args.concurrent_regions,
            concurrent_services=args.concurrent_services
        )
        
        resources = result.get('resources', [])
        raw_results = result.get('raw_results', {})
        
        elapsed = time.time() - start_time
        print(f"  Scanned {len(resources)} resources in {elapsed:.1f}s")
        
        # Persistence
        if args.inventory_table or args.bucket:
            # We need a proper account ID for persistence
            # In direct mode, we might need one.
            target_acc_id = acc_id
            if target_acc_id == 'direct-scan':
                # Try to get actual account ID from sts
                try:
                    target_acc_id = boto3.client('sts').get_caller_identity()['Account']
                except:
                    pass
            
            if args.inventory_table and dynamodb:
                count = process_and_store_resources(
                    dynamodb, s3, args.inventory_table, args.bucket, target_acc_id, resources, raw_results
                )
                print(f"  Persisted {count} items to DynamoDB")
                
                # Mark missing? Only if we are doing a "full" scan of the account
                # If doing partial regions, marking missing might be dangerous 
                # as it would mark resources in other regions as missing.
                # Logic: Only mark missing if we scanned ALL regions configured for the account?
                # Or just skip mark_missing in local runner to be safe.
                # User asked for "full scan support", so we should probably mark missing in full mode.
                
                if args.all_accounts and not args.regions:
                     # This looks like a full scan intent
                     discovered_arns = get_discovered_arns(resources, target_acc_id)
                     missing = mark_missing_resources(dynamodb, args.inventory_table, target_acc_id, discovered_arns)
                     print(f"  Marked {missing} missing resources")
                else:
                    print("  Skipping 'mark missing' (partial scan or safety check)")
                
                # Save sync status to APP_TABLE for the status endpoint
                if args.app_table:
                    from datetime import datetime, timezone
                    scan_ts = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
                    save_sync_status(dynamodb, args.app_table, f"SCAN#{scan_ts}", len(resources), 1)
                    
            if args.bucket and s3 and raw_results:
                 # Store raw is handled in process_and_store_resources
                 pass 
                 
            # Accumulate for merged
            if raw_results:
                all_results_data[target_acc_id] = raw_results

    # --- Merged Output ---
    if args.bucket and s3 and all_results_data:
        print("\nStoring merged results to S3...")
        timestamp = datetime.now(timezone.utc).isoformat()
        store_merged_to_s3(s3, args.bucket, all_results_data, timestamp)
        
    print("\nDone.")

if __name__ == '__main__':
    main()
