"""
Local Runner for testing the vector embedding pipeline.

Supports:
1. S3 mode:   Read normalized inventory files from S3 and generate embeddings
2. File mode: Process a local JSON file (for testing without S3)
3. Dry-run:   Show text representations without calling Bedrock (free, instant)
4. Upload:    Actually write vectors to S3 Vectors service

Usage examples:
  # Dry-run on a local JSON file (no AWS calls except identity)
  python local_runner.py --file ./sample-normalized.json --dry-run

  # Process normalized files from S3 (dry-run, no embeddings or writes)
  python local_runner.py --bucket nucleus-inventory-123456-ap-south-1 --prefix normalized/ --dry-run

  # Generate embeddings and write to S3 Vectors
  python local_runner.py --file ./sample.json --upload \\
      --vector-bucket nucleus-vectors-123456-ap-south-1 \\
      --vector-index text-embeddings

  # Full S3 pipeline (production test)
  python local_runner.py \\
      --bucket nucleus-inventory-123456-ap-south-1 \\
      --prefix normalized/20260308T120000/ \\
      --upload \\
      --vector-bucket nucleus-vectors-123456-ap-south-1 \\
      --vector-index text-embeddings
"""
import argparse
import json
import os
import sys
import time
import hashlib
import boto3
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

# Reuse the vector utils from the same directory
sys.path.insert(0, os.path.dirname(__file__))
from src.vector_utils import VectorGenerator


def compute_content_hash(text: str) -> str:
    """SHA-256 hash prefix for delta deduplication."""
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def load_resources_from_file(file_path: str) -> List[Dict[str, Any]]:
    """Load normalized resources from a local JSON file."""
    with open(file_path, 'r') as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"Expected a JSON array in {file_path}, got {type(data).__name__}")
    return data


def load_resources_from_s3(s3_client, bucket: str, key: str) -> List[Dict[str, Any]]:
    """Load normalized resources from an S3 object."""
    response = s3_client.get_object(Bucket=bucket, Key=key)
    data = json.loads(response['Body'].read().decode('utf-8'))
    if not isinstance(data, list):
        raise ValueError(f"Expected a JSON array at s3://{bucket}/{key}")
    return data


def list_s3_keys(s3_client, bucket: str, prefix: str) -> List[str]:
    """List all objects under an S3 prefix."""
    keys = []
    paginator = s3_client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get('Contents', []):
            if obj['Key'].endswith('.json'):
                keys.append(obj['Key'])
    return keys


def put_vectors_to_s3(s3vectors_client, vector_bucket: str, vector_index: str,
                      vectors: List[Dict[str, Any]]) -> int:
    """Write vectors to S3 Vectors in batches of 20."""
    BATCH_SIZE = 20
    total_written = 0

    for i in range(0, len(vectors), BATCH_SIZE):
        batch = vectors[i:i + BATCH_SIZE]
        s3vectors_client.put_vectors(
            vectorBucketName=vector_bucket,
            indexName=vector_index,
            vectors=[
                {
                    'key': v['key'],
                    'data': {'float32': v['embedding']},
                    'metadata': v['metadata'],
                }
                for v in batch
            ]
        )
        total_written += len(batch)
        print(f"    Uploaded batch {i // BATCH_SIZE + 1} ({len(batch)} vectors)")

    return total_written


def process_resources(
    resources: List[Dict[str, Any]],
    vector_gen: VectorGenerator,
    dry_run: bool = False,
    verbose: bool = False,
) -> List[Dict[str, Any]]:
    """
    Generate text representations and (optionally) embeddings for each resource.
    Returns list of vector records ready for upload.
    """
    vectors = []
    skipped = 0

    for i, resource in enumerate(resources):
        resource_id = resource.get('resourceId', '')
        if not resource_id:
            skipped += 1
            continue

        # Generate human-readable text representation
        text = vector_gen.create_resource_text(resource)
        if not text:
            skipped += 1
            continue

        content_hash = compute_content_hash(text)

        if verbose or dry_run:
            print(f"\n  [{i+1}/{len(resources)}] {resource.get('name', resource_id)}")
            print(f"    Type:    {resource.get('resourceType', 'unknown')}")
            print(f"    Region:  {resource.get('region', 'unknown')}")
            print(f"    Account: {resource.get('accountId', 'unknown')}")
            print(f"    Text:    {text[:200]}{'...' if len(text) > 200 else ''}")
            print(f"    Hash:    {content_hash}")

        if dry_run:
            # In dry-run mode, don't call Bedrock — just show what would happen
            vectors.append({
                'key': f"{resource_id}_{content_hash}",
                'embedding': [],  # empty in dry-run
                'metadata': {
                    'resourceId': resource_id,
                    'resourceType': resource.get('resourceType', ''),
                    'name': resource.get('name', resource_id),
                    'region': resource.get('region', ''),
                    'accountId': resource.get('accountId', ''),
                    'state': resource.get('state', ''),
                    'service': resource.get('service', ''),
                    'contentHash': content_hash,
                    'text_content': text[:500],
                },
            })
            continue

        # Generate embedding via Bedrock Titan v2
        try:
            embedding = vector_gen.generate_embedding(text)
            if not embedding:
                print(f"    WARNING: Empty embedding for {resource_id}")
                skipped += 1
                continue

            vectors.append({
                'key': f"{resource_id}_{content_hash}",
                'embedding': embedding,
                'metadata': {
                    'resourceId': resource_id,
                    'resourceArn': resource.get('resourceArn', ''),
                    'resourceType': resource.get('resourceType', ''),
                    'name': resource.get('name', resource_id),
                    'region': resource.get('region', ''),
                    'accountId': resource.get('accountId', ''),
                    'state': resource.get('state', ''),
                    'service': resource.get('service', ''),
                    'contentHash': content_hash,
                    'text_content': text[:500],
                    'lastDiscoveredAt': resource.get('lastDiscoveredAt', datetime.now(timezone.utc).isoformat()),
                },
            })
        except Exception as e:
            print(f"    ERROR generating embedding for {resource_id}: {e}")
            skipped += 1

    if skipped > 0:
        print(f"\n  Skipped {skipped} resources (no ID or embedding failure)")

    return vectors


def main():
    parser = argparse.ArgumentParser(
        description='Local runner for inventory vector embedding pipeline',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )

    # Input source
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument('--file', type=str,
                              help='Path to local normalized resources JSON file')
    source_group.add_argument('--bucket', type=str,
                              help='S3 bucket name containing normalized inventory files')

    # S3 mode options
    parser.add_argument('--prefix', type=str, default='normalized/',
                        help='S3 prefix to list files from (default: normalized/)')

    # Processing options
    parser.add_argument('--dry-run', action='store_true',
                        help='Show text representations without calling Bedrock (no cost)')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Print details for every resource')

    # Upload options
    parser.add_argument('--upload', action='store_true',
                        help='Upload generated vectors to S3 Vectors')
    parser.add_argument('--vector-bucket', type=str,
                        default=os.environ.get('VECTOR_BUCKET_NAME'),
                        help='S3 Vectors bucket name for upload (or VECTOR_BUCKET_NAME env var)')
    parser.add_argument('--vector-index', type=str,
                        default=os.environ.get('VECTOR_INDEX_NAME', 'text-embeddings'),
                        help='S3 Vectors index name (default: text-embeddings)')

    # Output
    parser.add_argument('--output', type=str,
                        help='Save generated vectors to a local JSON file')

    # AWS config
    parser.add_argument('--region', type=str,
                        default=os.environ.get('AWS_REGION', 'ap-south-1'),
                        help='AWS region (default: ap-south-1)')
    parser.add_argument('--profile', type=str,
                        default=os.environ.get('AWS_PROFILE'),
                        help='AWS profile name')

    args = parser.parse_args()

    # Validation
    if args.upload and not args.dry_run:
        if not args.vector_bucket:
            parser.error("--vector-bucket is required for --upload (or set VECTOR_BUCKET_NAME)")
        if not args.vector_index:
            parser.error("--vector-index is required for --upload")

    print("=" * 60)
    print("Inventory Vector Embedding - Local Runner")
    print("=" * 60)
    print(f"Mode:     {'DRY RUN (no Bedrock calls)' if args.dry_run else 'EMBEDDING'}")
    print(f"Upload:   {'Yes → ' + (args.vector_bucket or '') + '/' + (args.vector_index or '') if args.upload and not args.dry_run else 'No'}")
    print(f"Region:   {args.region}")
    if args.profile:
        print(f"Profile:  {args.profile}")
    print()

    # Set up AWS session
    session_kwargs: Dict[str, Any] = {'region_name': args.region}
    if args.profile:
        session_kwargs['profile_name'] = args.profile
    session = boto3.Session(**session_kwargs)

    # Initialize vector generator with session
    vector_gen = VectorGenerator(region_name=args.region, session=session)
    # Override model to use Titan v2 (matching CDK config, 1024-dim)
    vector_gen.model_id = "amazon.titan-embed-text-v2:0"

    # --- Load resources ---
    all_resources: List[Dict[str, Any]] = []

    if args.file:
        print(f"Loading from file: {args.file}")
        try:
            all_resources = load_resources_from_file(args.file)
            print(f"Loaded {len(all_resources)} resources")
        except Exception as e:
            print(f"ERROR: {e}")
            sys.exit(1)

    elif args.bucket:
        s3_client = session.client('s3')
        print(f"Listing files in s3://{args.bucket}/{args.prefix}")
        try:
            keys = list_s3_keys(s3_client, args.bucket, args.prefix)
            print(f"Found {len(keys)} JSON file(s):")
            for k in keys:
                print(f"  {k}")
        except Exception as e:
            print(f"ERROR listing S3: {e}")
            sys.exit(1)

        for key in keys:
            print(f"\nReading: s3://{args.bucket}/{key}")
            try:
                resources = load_resources_from_s3(s3_client, args.bucket, key)
                print(f"  Loaded {len(resources)} resources")
                all_resources.extend(resources)
            except Exception as e:
                print(f"  ERROR: {e}")

    if not all_resources:
        print("\nNo resources to process. Exiting.")
        sys.exit(0)

    print(f"\nTotal resources to process: {len(all_resources)}")
    print("-" * 40)

    # --- Generate embeddings ---
    start_time = time.time()
    vectors = process_resources(
        all_resources,
        vector_gen,
        dry_run=args.dry_run,
        verbose=args.verbose,
    )
    elapsed = time.time() - start_time

    print(f"\n{'=' * 40}")
    print(f"Processed:  {len(vectors)} resources → vectors")
    print(f"Elapsed:    {elapsed:.1f}s")
    if not args.dry_run and len(vectors) > 0:
        print(f"Avg time:   {elapsed / len(vectors):.2f}s per resource")

    if args.dry_run:
        print("\n[DRY RUN] No embeddings generated, no vectors uploaded.")
        print("Remove --dry-run to generate real embeddings.")

    # --- Save to local file ---
    if args.output:
        output_data = [
            {k: v for k, v in vec.items() if k != 'embedding'}  # exclude large float arrays
            for vec in vectors
        ]
        with open(args.output, 'w') as f:
            json.dump(output_data, f, indent=2)
        print(f"\nSaved vector metadata to: {args.output}")

    # --- Upload to S3 Vectors ---
    if args.upload and not args.dry_run and vectors:
        print(f"\nUploading {len(vectors)} vectors to {args.vector_bucket}/{args.vector_index}...")
        try:
            s3vectors_client = session.client('s3vectors', region_name=args.region)
            written = put_vectors_to_s3(s3vectors_client, args.vector_bucket, args.vector_index, vectors)
            print(f"Successfully uploaded {written} vectors.")
        except Exception as e:
            print(f"ERROR uploading vectors: {e}")
            sys.exit(1)

    print("\nDone.")


if __name__ == '__main__':
    main()
