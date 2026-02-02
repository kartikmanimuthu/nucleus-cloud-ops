import boto3
import os

TABLE_NAME = 'nucleus-app-inventory-table'

def truncate_table():
    print(f"Truncating table: {TABLE_NAME}")
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(TABLE_NAME)
    
    # Scan to get keys
    scan = table.scan(
        ProjectionExpression='pk, sk'
    )
    
    items = scan.get('Items', [])
    while 'LastEvaluatedKey' in scan:
        scan = table.scan(
            ProjectionExpression='pk, sk',
            ExclusiveStartKey=scan['LastEvaluatedKey']
        )
        items.extend(scan.get('Items', []))
        
    print(f"Found {len(items)} items to delete.")
    
    if not items:
        print("Table is already empty.")
        return

    # Batch delete
    with table.batch_writer() as batch:
        for i, item in enumerate(items):
            batch.delete_item(
                Key={
                    'pk': item['pk'],
                    'sk': item['sk']
                }
            )
            if (i + 1) % 100 == 0:
                print(f"Deleted {i + 1} items...")
                
    print("Truncate completed.")

if __name__ == '__main__':
    truncate_table()
