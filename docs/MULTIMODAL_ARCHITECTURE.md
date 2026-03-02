# Multimodal Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER INTERFACE                               │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Chat Interface (chat-interface.tsx)                       │    │
│  │  ┌──────────────────────────────────────────────────────┐  │    │
│  │  │  Text Input (Textarea)                               │  │    │
│  │  │  "Analyze this AWS architecture diagram"             │  │    │
│  │  └──────────────────────────────────────────────────────┘  │    │
│  │  ┌──────────────────────────────────────────────────────┐  │    │
│  │  │  File Upload Component (file-upload.tsx)             │  │    │
│  │  │  ┌────────┐ ┌────────┐ ┌────────┐                   │  │    │
│  │  │  │ [IMG1] │ │ [IMG2] │ │ [IMG3] │  [Attach Images]  │  │    │
│  │  │  └────────┘ └────────┘ └────────┘                   │  │    │
│  │  └──────────────────────────────────────────────────────┘  │    │
│  │                                                              │    │
│  │  State: attachments: FileAttachment[]                       │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ sendMessage()
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      MESSAGE PAYLOAD                                 │
│  {                                                                   │
│    content: "Analyze this AWS architecture diagram",                │
│    role: "user",                                                     │
│    experimental_attachments: [                                       │
│      {                                                               │
│        name: "architecture.png",                                     │
│        contentType: "image/png",                                     │
│        url: "data:image/png;base64,iVBORw0KGgoAAAANS..."           │
│      }                                                               │
│    ]                                                                 │
│  }                                                                   │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ POST /api/chat
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      API ROUTE (route.ts)                            │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Message Conversion                                         │    │
│  │                                                              │    │
│  │  if (experimental_attachments?.length > 0) {                │    │
│  │    content = [                                              │    │
│  │      { type: 'text', text: 'Analyze this...' },            │    │
│  │      {                                                       │    │
│  │        type: 'image_url',                                   │    │
│  │        image_url: { url: 'data:image/png;base64,...' }     │    │
│  │      }                                                       │    │
│  │    ]                                                         │    │
│  │  }                                                           │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ new HumanMessage({ content })
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    LANGCHAIN MESSAGE                                 │
│  HumanMessage({                                                      │
│    content: [                                                        │
│      { type: 'text', text: 'Analyze this AWS architecture...' },   │
│      {                                                               │
│        type: 'image_url',                                           │
│        image_url: {                                                 │
│          url: 'data:image/png;base64,iVBORw0KGgoAAAANS...'         │
│        }                                                             │
│      }                                                               │
│    ]                                                                 │
│  })                                                                  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ graph.streamEvents()
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    AGENT GRAPH                                       │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Fast Agent / Planning Agent                               │    │
│  │                                                              │    │
│  │  ┌──────────────────────────────────────────────────────┐  │    │
│  │  │  Agent Node                                          │  │    │
│  │  │  - Receives multimodal message                       │  │    │
│  │  │  - Processes with ChatBedrockConverse                │  │    │
│  │  │  - No code changes needed                            │  │    │
│  │  └──────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ model.invoke()
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  CHATBEDROCKCONVERSE                                 │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Converts to Bedrock format:                               │    │
│  │                                                              │    │
│  │  {                                                           │    │
│  │    "role": "user",                                          │    │
│  │    "content": [                                             │    │
│  │      {                                                       │    │
│  │        "type": "text",                                      │    │
│  │        "text": "Analyze this AWS architecture..."          │    │
│  │      },                                                      │    │
│  │      {                                                       │    │
│  │        "type": "image",                                     │    │
│  │        "source": {                                          │    │
│  │          "type": "base64",                                  │    │
│  │          "media_type": "image/png",                         │    │
│  │          "data": "iVBORw0KGgoAAAANS..."                    │    │
│  │        }                                                     │    │
│  │      }                                                       │    │
│  │    ]                                                         │    │
│  │  }                                                           │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ AWS SDK
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      AWS BEDROCK                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Claude 4.5 Sonnet (Vision Model)                          │    │
│  │                                                              │    │
│  │  1. Processes text prompt                                   │    │
│  │  2. Analyzes image content                                  │    │
│  │  3. Combines understanding                                  │    │
│  │  4. Generates response                                      │    │
│  │                                                              │    │
│  │  Response: "This architecture shows a 3-tier web app..."   │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ Streaming response
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      RESPONSE STREAM                                 │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  createUIMessageStreamResponse()                            │    │
│  │                                                              │    │
│  │  Streams back to client:                                    │    │
│  │  - Text chunks                                              │    │
│  │  - Tool calls (if any)                                      │    │
│  │  - Phase markers                                            │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ SSE stream
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      USER INTERFACE                                  │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Message Display                                            │    │
│  │                                                              │    │
│  │  [User Message]                                             │    │
│  │  ┌────────────────────────────────────────────────────┐    │    │
│  │  │ "Analyze this AWS architecture diagram"            │    │    │
│  │  │                                                      │    │    │
│  │  │ [Architecture Diagram Image]                        │    │    │
│  │  └────────────────────────────────────────────────────┘    │    │
│  │                                                              │    │
│  │  [AI Response]                                              │    │
│  │  ┌────────────────────────────────────────────────────┐    │    │
│  │  │ "This architecture shows a 3-tier web application   │    │    │
│  │  │  with the following components:                     │    │    │
│  │  │                                                      │    │    │
│  │  │  1. CloudFront for CDN                              │    │    │
│  │  │  2. ALB for load balancing                          │    │    │
│  │  │  3. ECS Fargate for compute                         │    │    │
│  │  │  4. RDS for database                                │    │    │
│  │  │                                                      │    │    │
│  │  │  Recommendations:                                    │    │    │
│  │  │  - Add Multi-AZ for RDS                             │    │    │
│  │  │  - Implement WAF on CloudFront                      │    │    │
│  │  │  - Add ElastiCache for session management..."       │    │    │
│  │  └────────────────────────────────────────────────────┘    │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow Summary

1. **User uploads image** → FileUpload component validates and encodes to base64
2. **User sends message** → ChatInterface includes experimental_attachments
3. **API receives request** → Converts to LangChain multimodal format
4. **Agent processes** → HumanMessage with text + image content
5. **ChatBedrockConverse** → Converts to Bedrock API format
6. **AWS Bedrock** → Claude processes text + image together
7. **Response streams back** → Displayed in chat interface

## Key Components

### FileUpload Component
- Validates file type and size
- Generates base64 encoding
- Provides preview UI
- Manages attachment state

### Chat Interface
- Integrates FileUpload component
- Manages attachments array
- Sends multimodal messages
- Displays images in chat history

### API Route
- Detects experimental_attachments
- Converts to LangChain format
- Maintains backward compatibility
- Handles streaming responses

### Agent Graph
- No changes needed
- Automatically handles multimodal
- Works with all agent modes
- Compatible with all tools

### ChatBedrockConverse
- Converts to Bedrock format
- Handles base64 decoding
- Supports all Claude models
- Manages streaming responses

## Message Format Evolution

```
User Input (Browser)
    ↓
Vercel AI SDK Format (experimental_attachments)
    ↓
LangChain Format (content array with text + image_url)
    ↓
Bedrock Format (content array with text + image objects)
    ↓
Claude Processing (multimodal understanding)
    ↓
Response (text stream)
    ↓
UI Display (markdown + images)
```

## Security & Validation

```
┌─────────────────────────────────────────┐
│  Client-Side Validation                 │
│  - File type whitelist                  │
│  - 5MB size limit                       │
│  - Base64 encoding                      │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│  API Validation                         │
│  - Message structure validation         │
│  - Content type verification            │
│  - Size checks                          │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│  AWS Bedrock                            │
│  - Content moderation                   │
│  - Token limits                         │
│  - Rate limiting                        │
└─────────────────────────────────────────┘
```

## Performance Considerations

```
Image Size    → Token Cost    → Response Time
─────────────────────────────────────────────
< 500KB       → ~800 tokens   → +0.5s
500KB - 2MB   → ~1600 tokens  → +1.0s
2MB - 5MB     → ~3200 tokens  → +2.0s
```

## Error Handling

```
┌─────────────────────────────────────────┐
│  File Too Large                         │
│  → Show error message                   │
│  → Suggest compression                  │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Invalid File Type                      │
│  → Show error message                   │
│  → List supported types                 │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Upload Failed                          │
│  → Retry mechanism                      │
│  → Clear failed uploads                 │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  API Error                              │
│  → Log error details                    │
│  → Show user-friendly message           │
│  → Preserve user input                  │
└─────────────────────────────────────────┘
```
