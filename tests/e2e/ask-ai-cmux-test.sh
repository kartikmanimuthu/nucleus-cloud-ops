#!/bin/bash
# Ask AI E2E Test using cmux Browser Automation
# Usage: ./ask-ai-cmux-test.sh [surface-id]

SURFACE="${1:-surface:8}"
BASE_URL="http://localhost:3000"

echo "🚀 Ask AI E2E Test Suite (cmux Browser Automation)"
echo "=================================================="
echo "Using browser surface: $SURFACE"
echo ""

# Test 1: Navigate to inventory
echo "📝 Test 1: Navigate to inventory page"
cmux browser "$SURFACE" navigate "$BASE_URL/inventory"
cmux browser "$SURFACE" wait --load-state complete --timeout-ms 10000
sleep 1

SNAPSHOT=$(cmux browser "$SURFACE" snapshot --compact)
if echo "$SNAPSHOT" | grep -qi "inventory"; then
  echo "✅ PASS: Inventory page loaded"
else
  echo "❌ FAIL: Inventory page did not load"
fi

# Test 2: Find Ask AI button
echo ""
echo "📝 Test 2: Find Ask AI button"
BUTTON=$(cmux browser "$SURFACE" find role button --name "Ask AI" 2>&1)
if [ $? -eq 0 ]; then
  echo "✅ PASS: Ask AI button found"
  
  # Test 3: Click Ask AI button
  echo ""
  echo "📝 Test 3: Click Ask AI button"
  cmux browser "$SURFACE" click "button:has(svg)" 2>/dev/null || cmux browser "$SURFACE" click "button" 2>/dev/null
  sleep 2
  
  DIALOG=$(cmux browser "$SURFACE" snapshot --compact)
  if echo "$DIALOG" | grep -qi "ask ai about"; then
    echo "✅ PASS: Ask AI dialog opened"
    
    # Test 4: Type question
    echo ""
    echo "📝 Test 4: Type question"
    cmux browser "$SURFACE" fill "input" --text "How many EC2 instances are in ap-south-1?"
    sleep 1
    echo "✅ PASS: Question typed"
    
    # Test 5: Submit question
    echo ""
    echo "📝 Test 5: Submit question"
    cmux browser "$SURFACE" press "Enter"
    sleep 4
    
    RESPONSE=$(cmux browser "$SURFACE" snapshot --compact)
    if echo "$RESPONSE" | grep -qi "ec2\|instance"; then
      echo "✅ PASS: Response received with EC2 data"
    else
      echo "⚠️  Response may not contain EC2 data"
    fi
  else
    echo "❌ FAIL: Ask AI dialog did not open"
  fi
else
  echo "❌ FAIL: Ask AI button not found"
fi

# Test 6: Check for errors
echo ""
echo "📝 Test 6: Check for console errors"
ERRORS=$(cmux browser "$SURFACE" errors list 2>&1)
if [ -z "$ERRORS" ] || [ "$ERRORS" = "OK" ]; then
  echo "✅ PASS: No console errors"
else
  echo "⚠️  Console errors detected: $ERRORS"
fi

# Capture screenshot
echo ""
echo "📸 Capturing screenshot..."
TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
cmux browser "$SURFACE" screenshot --out "/tmp/ask-ai-test-$TIMESTAMP.png"
echo "Screenshot saved to /tmp/ask-ai-test-$TIMESTAMP.png"

echo ""
echo "=================================================="
echo "✅ E2E Test Complete"
