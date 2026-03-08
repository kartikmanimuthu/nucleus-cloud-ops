# Ask AI E2E Manual Test Guide

## Prerequisites
- Web UI running at http://localhost:3000
- User authenticated and logged in
- Inventory data synced (at least some EC2 instances in ap-south-1)

## Test 1: Ask AI Dialog Opens and Responds

1. Navigate to http://localhost:3000/inventory
2. Wait for inventory page to load
3. Click the "Ask AI" button (Sparkles icon in top right)
4. Verify dialog opens with title "Ask AI about your inventory"
5. Type question: "How many EC2 instances are in ap-south-1?"
6. Click Send button
7. Wait for response (3-5 seconds)
8. **Verify:**
   - Response contains "EC2" or "instance"
   - Response mentions "ap-south-1"
   - No errors in console

## Test 2: Multi-turn Conversation

1. From Test 1, after first response appears
2. Look for "Suggested follow-ups" section
3. Click "Tell me more about the first one" button
4. Wait for follow-up response (3-5 seconds)
5. **Verify:**
   - Both messages visible in conversation
   - First question still visible
   - Follow-up response appears below
   - Context maintained (mentions same resource)

## Test 3: Ask AI with Active Filters

1. Navigate to http://localhost:3000/inventory
2. Set Region filter to "ap-south-1"
3. Click "Ask AI" button
4. **Verify:**
   - Dialog shows badge "ap-south-1" in description
5. Type: "List all resources"
6. Click Send
7. Wait for response
8. **Verify:**
   - Response respects filter (only mentions ap-south-1 resources)
   - Filter badge visible in dialog

## Test 4: Sources/Citations

1. From any Ask AI response
2. Look for "Sources" section below the response
3. **Verify:**
   - Sources section appears (if response includes citations)
   - Each source shows resource ID and type
   - No errors when viewing sources

## Expected Behavior

- Dialog opens smoothly without errors
- Questions are answered with relevant resource data
- Multi-turn conversations maintain context
- Active filters are respected in responses
- Sources are properly cited
- No console errors or warnings

## Troubleshooting

- If dialog doesn't open: Check browser console for errors
- If no response: Verify API endpoint `/api/ask-ai` is working
- If response is empty: Check inventory data is synced
- If sources don't show: This is optional, not all responses have sources
