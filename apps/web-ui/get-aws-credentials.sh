#!/bin/bash

# Helper script to get AWS credentials for the Cost Scheduler Web UI
# This script helps extract AWS credentials from your current environment

echo "=== AWS Credentials Helper ==="
echo ""

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed. Please install it first:"
    echo "   brew install awscli"
    echo ""
    exit 1
fi

echo "🔍 Checking current AWS configuration..."
echo ""

# Get current AWS identity
echo "Current AWS Identity:"
aws sts get-caller-identity 2>/dev/null || {
    echo "❌ No valid AWS credentials found."
    echo ""
    echo "Please configure AWS credentials using one of these methods:"
    echo "1. aws configure"
    echo "2. aws configure sso"
    echo "3. Set environment variables"
    echo ""
    exit 1
}

echo ""
echo "🔑 Getting temporary credentials..."

# Get temporary credentials if using SSO or roles
if aws sts get-session-token &> /dev/null; then
    CREDS=$(aws sts get-session-token --output json)
    
    ACCESS_KEY=$(echo $CREDS | jq -r '.Credentials.AccessKeyId')
    SECRET_KEY=$(echo $CREDS | jq -r '.Credentials.SecretAccessKey')
    SESSION_TOKEN=$(echo $CREDS | jq -r '.Credentials.SessionToken')
    
    echo "✅ Temporary credentials obtained!"
    echo ""
    echo "Add these to your root .env file:"
    echo ""
    echo "NEXT_PUBLIC_AWS_ACCESS_KEY_ID=$ACCESS_KEY"
    echo "NEXT_PUBLIC_AWS_SECRET_ACCESS_KEY=$SECRET_KEY"
    echo "NEXT_PUBLIC_AWS_SESSION_TOKEN=$SESSION_TOKEN"
    echo ""
    echo "⚠️  Note: These credentials will expire. You may need to run this script again."
else
    echo "ℹ️  Using long-term credentials (no session token needed)"
    echo ""
    echo "Your current credentials should work directly."
    echo "Check your ~/.aws/credentials file or environment variables."
fi

echo ""
echo "🔧 Make sure your root .env file has the correct table name:"
echo "NEXT_PUBLIC_APP_TABLE_NAME=NucleusAppTable"
echo "NEXT_PUBLIC_AUDIT_TABLE_NAME=NucleusAuditTable"
echo ""
echo "📊 You can find the actual table name from your CDK deployment outputs."
