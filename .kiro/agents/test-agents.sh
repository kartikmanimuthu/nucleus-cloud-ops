#!/bin/bash

# Kiro Agent Integration Test
# Tests both Antigravity Planning and Vibe agents

set -e

echo "🧪 Testing Kiro Custom Agents for Nucleus Cloud Ops"
echo "=================================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Verify agent files exist
echo "📁 Test 1: Verifying agent configuration files..."
if [ -f ".kiro/agents/antigravity-planning.json" ] && [ -f ".kiro/agents/antigravity-vibe.json" ]; then
    echo -e "${GREEN}✓${NC} Agent config files exist"
else
    echo -e "${RED}✗${NC} Agent config files missing"
    exit 1
fi

# Test 2: Verify steering files exist
echo "📁 Test 2: Verifying steering files..."
STEERING_FILES=(
    ".kiro/steering/aws-best-practices.md"
    ".kiro/steering/antigravity-planning-workflow.md"
    ".kiro/steering/antigravity-vibe-workflow.md"
    ".kiro/steering/structure.md"
    ".kiro/steering/tech.md"
    ".kiro/steering/product.md"
)

for file in "${STEERING_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo -e "${GREEN}✓${NC} $file"
    else
        echo -e "${RED}✗${NC} $file missing"
        exit 1
    fi
done

# Test 3: Validate JSON syntax
echo ""
echo "🔍 Test 3: Validating JSON syntax..."
if command -v jq &> /dev/null; then
    for json_file in .kiro/agents/*.json; do
        if jq empty "$json_file" 2>/dev/null; then
            echo -e "${GREEN}✓${NC} $(basename $json_file) is valid JSON"
        else
            echo -e "${RED}✗${NC} $(basename $json_file) has invalid JSON"
            exit 1
        fi
    done
else
    echo -e "${YELLOW}⚠${NC} jq not installed, skipping JSON validation"
fi

# Test 4: Verify agent references correct files
echo ""
echo "🔗 Test 4: Verifying agent resource references..."
PLANNING_PROMPT=$(jq -r '.prompt' .kiro/agents/antigravity-planning.json)
VIBE_PROMPT=$(jq -r '.prompt' .kiro/agents/antigravity-vibe.json)

if [[ $PLANNING_PROMPT == "file://.kiro/steering/antigravity-planning-workflow.md" ]]; then
    echo -e "${GREEN}✓${NC} Planning agent references correct workflow"
else
    echo -e "${RED}✗${NC} Planning agent has incorrect prompt reference"
    exit 1
fi

if [[ $VIBE_PROMPT == "file://.kiro/steering/antigravity-vibe-workflow.md" ]]; then
    echo -e "${GREEN}✓${NC} Vibe agent references correct workflow"
else
    echo -e "${RED}✗${NC} Vibe agent has incorrect prompt reference"
    exit 1
fi

# Test 5: Verify AWS best practices content
echo ""
echo "🔍 Test 5: Verifying AWS best practices content..."
AWS_BP_FILE=".kiro/steering/aws-best-practices.md"
REQUIRED_SECTIONS=(
    "Security & IAM"
    "DynamoDB Patterns"
    "Lambda Best Practices"
    "AI Agent (LangGraph + Bedrock)"
    "CDK Infrastructure"
)

for section in "${REQUIRED_SECTIONS[@]}"; do
    if grep -q "$section" "$AWS_BP_FILE"; then
        echo -e "${GREEN}✓${NC} Found section: $section"
    else
        echo -e "${RED}✗${NC} Missing section: $section"
        exit 1
    fi
done

# Test 6: Verify documentation exists
echo ""
echo "📚 Test 6: Verifying documentation..."
if [ -f ".kiro/agents/README.md" ] && [ -f ".kiro/agents/QUICK_REFERENCE.md" ]; then
    echo -e "${GREEN}✓${NC} Documentation files exist"
else
    echo -e "${RED}✗${NC} Documentation files missing"
    exit 1
fi

# Test 7: Check for AWS SDK v3 references
echo ""
echo "🔍 Test 7: Verifying AWS SDK v3 enforcement..."
if grep -q "@aws-sdk/client-" "$AWS_BP_FILE"; then
    echo -e "${GREEN}✓${NC} AWS SDK v3 pattern found in best practices"
else
    echo -e "${RED}✗${NC} AWS SDK v3 pattern missing"
    exit 1
fi

# Test 8: Verify model configuration
echo ""
echo "🤖 Test 8: Verifying AI model configuration..."
PLANNING_MODEL=$(jq -r '.model' .kiro/agents/antigravity-planning.json)
VIBE_MODEL=$(jq -r '.model' .kiro/agents/antigravity-vibe.json)

if [[ $PLANNING_MODEL == "claude-3-5-sonnet-latest" ]] && [[ $VIBE_MODEL == "claude-3-5-sonnet-latest" ]]; then
    echo -e "${GREEN}✓${NC} Both agents use Claude 3.5 Sonnet"
else
    echo -e "${RED}✗${NC} Incorrect model configuration"
    exit 1
fi

# Summary
echo ""
echo "=================================================="
echo -e "${GREEN}✅ All tests passed!${NC}"
echo ""
echo "🚀 Agents are ready to use:"
echo "   • kiro chat --agent \"Gemini Antigravity Planning\""
echo "   • kiro chat --agent \"Gemini Antigravity Vibe\""
echo ""
echo "📖 Documentation:"
echo "   • .kiro/agents/README.md"
echo "   • .kiro/agents/QUICK_REFERENCE.md"
echo "   • .kiro/steering/aws-best-practices.md"
echo ""
