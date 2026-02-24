import json
import boto3
import os
from typing import List, Dict, Any

class VectorGenerator:
    def __init__(self, region_name: str = None):
        self.region = region_name or os.environ.get('AWS_REGION', 'ap-south-1')
        self.bedrock = boto3.client('bedrock-runtime', region_name=self.region)
        self.model_id = "amazon.titan-embed-text-v1"

    def generate_embedding(self, text: str) -> List[float]:
        try:
            body = json.dumps({"inputText": text})
            response = self.bedrock.invoke_model(
                body=body,
                modelId=self.model_id,
                accept='application/json',
                contentType='application/json'
            )
            response_body = json.loads(response.get('body').read())
            return response_body.get('embedding')
        except Exception as e:
            print(f"Error generating embedding: {e}")
            return []

    def create_resource_text(self, resource: Dict[str, Any]) -> str:
        parts = []
        
        # Core identification
        parts.append(f"Name: {resource.get('name', 'Unknown')}")
        parts.append(f"Type: {resource.get('resourceType', 'Unknown')}")
        parts.append(f"Service: {resource.get('service', 'Unknown')}")
        
        # Location
        parts.append(f"Region: {resource.get('region', 'Unknown')}")
        parts.append(f"Account: {resource.get('accountId', 'Unknown')}")
        
        # Tags (key=value)
        tags = resource.get('tags', {})
        if tags and isinstance(tags, dict):
            tag_list = [f"{k}={v}" for k, v in tags.items()]
            parts.append(f"Tags: {', '.join(tag_list)}")
            
        # Metadata (flattened if simple)
        meta = resource.get('metadata', {})
        if meta and isinstance(meta, dict):
            meta_list = []
            for k, v in meta.items():
                if isinstance(v, (str, int, float, bool)):
                    meta_list.append(f"{k}={v}")
                elif isinstance(v, list) and len(v) < 5: # Small lists ok
                    meta_list.append(f"{k}={v}")
            if meta_list:
                parts.append(f"Details: {', '.join(meta_list)}")
                
        return " | ".join(parts)
