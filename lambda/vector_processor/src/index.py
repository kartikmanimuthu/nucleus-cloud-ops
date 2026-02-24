import json
import boto3
import os
import urllib.parse
from vector_utils import VectorGenerator

s3_client = boto3.client('s3')
bedrock_client = boto3.client('bedrock-runtime')

def handler(event, context):
    print("Received event: " + json.dumps(event, indent=2))
    
    # Initialize Vector Generator
    vector_gen = VectorGenerator(region_name=os.environ.get('AWS_REGION'))
    
    for record in event['Records']:
        bucket = record['s3']['bucket']['name']
        key = urllib.parse.unquote_plus(record['s3']['object']['key'], encoding='utf-8')
        
        # Only process files in merged/ prefix
        if not key.startswith('merged/'):
            print(f"Skipping key {key}, not in merged/ prefix")
            continue
            
        try:
            print(f"Processing object {key} from bucket {bucket}")
            response = s3_client.get_object(Bucket=bucket, Key=key)
            file_content = response['Body'].read().decode('utf-8')
            resources = json.loads(file_content)
            
            vectors = []
            
            for resource in resources:
                # Generate text representation
                text = vector_gen.create_resource_text(resource)
                if not text:
                    continue
                    
                # Generate embedding
                embedding = vector_gen.generate_embedding(text)
                if not embedding:
                    print(f"Failed to generate embedding for resource {resource.get('resourceId')}")
                    continue
                
                # Create vector record
                vector_record = {
                    'id': resource.get('resourceId'),
                    'accountId': resource.get('accountId'),
                    'region': resource.get('region'),
                    'resourceType': resource.get('resourceType'),
                    'text': text,
                    'vector': embedding,
                    'metadata': resource # include full resource for simpler retrieval
                }
                vectors.append(vector_record)
                
            # Save vectors to S3
            # Use same filename but in vectors/ prefix
            vector_key = key.replace('merged/', 'vectors/', 1)
            
            print(f"Saving {len(vectors)} vectors to {vector_key}")
            
            s3_client.put_object(
                Bucket=bucket,
                Key=vector_key,
                Body=json.dumps(vectors),
                ContentType='application/json'
            )
            
        except Exception as e:
            print(f"Error processing object {key} from bucket {bucket}.")
            print(e)
            raise e
            
    return {
        'statusCode': 200,
        'body': json.dumps('Vector generation completed')
    }
