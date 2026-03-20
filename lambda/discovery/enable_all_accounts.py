import boto3
from boto3.dynamodb.conditions import Key

TABLE = 'nucleus-app-app-table'

def enable_all_accounts():
    session = boto3.Session(profile_name='STX-CLOUD-PLATFORM-ADMIN')
    dynamodb = session.resource('dynamodb')
    table = dynamodb.Table(TABLE)

    resp = table.query(
        IndexName='GSI1',
        KeyConditionExpression=Key('gsi1pk').eq('TYPE#ACCOUNT')
    )
    accounts = resp.get('Items', [])
    print(f"Found {len(accounts)} accounts")

    for acct in accounts:
        account_id = acct.get('accountId')
        account_name = acct.get('accountName')
        if acct.get('active') is True:
            print(f"  SKIP (already active): {account_id} {account_name}")
            continue

        table.update_item(
            Key={'pk': acct['pk'], 'sk': acct['sk']},
            UpdateExpression='SET active = :t, gsi3pk = :gsi3',
            ExpressionAttributeValues={
                ':t': True,
                ':gsi3': 'STATUS#active',
            }
        )
        print(f"  ENABLED: {account_id} {account_name}")

    print("Done.")

if __name__ == '__main__':
    enable_all_accounts()
