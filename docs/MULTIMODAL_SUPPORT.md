# Multimodal Support - File Upload Feature

## Overview

Nucleus Cloud Ops now supports multimodal interactions, allowing users to upload images alongside text prompts to the AI agent. This enables visual analysis, diagram interpretation, screenshot troubleshooting, and more.

## Features

- **Image Upload**: Attach images (JPEG, PNG, GIF, WebP) to your messages
- **Multiple Files**: Upload multiple images in a single message
- **Preview**: Visual preview of attached images before sending
- **Size Limit**: 5MB per file to ensure optimal performance
- **Inline Display**: Images are displayed inline in the chat history

## Supported Models

All Claude models in the platform support multimodal inputs:
- Claude 4.5 Sonnet
- Claude 4.5 Haiku  
- Claude 4.5 Opus
- Claude 4.6 Sonnet
- Claude 4.6 Opus

Amazon Nova models also support multimodal:
- Nova 2 Lite

## Usage

### Uploading Images

1. Click the **"Attach Images"** button below the text input area
2. Select one or more image files from your device
3. Preview the attached images in the upload area
4. Type your message/question about the images
5. Click Send to submit

### Removing Images

- Hover over any attached image preview
- Click the **X** button in the top-right corner to remove it

### Example Use Cases

**Infrastructure Diagrams**
```
[Upload architecture diagram]
"Analyze this AWS architecture and suggest improvements for high availability"
```

**Error Screenshots**
```
[Upload error screenshot]
"What's causing this CloudWatch error and how do I fix it?"
```

**Dashboard Analysis**
```
[Upload dashboard screenshot]
"Review these metrics and identify any anomalies"
```

**Code Review**
```
[Upload code screenshot]
"Review this Terraform configuration for security issues"
```

## Technical Details

### File Constraints

- **Allowed Types**: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- **Max Size**: 5MB per file
- **Encoding**: Base64 for transmission

### API Integration

Images are sent as part of the message payload using the `experimental_attachments` field:

```typescript
{
  content: "Your text message",
  role: "user",
  experimental_attachments: [
    {
      name: "screenshot.png",
      contentType: "image/png",
      url: "data:image/png;base64,..."
    }
  ]
}
```

### Backend Processing

The API route converts attachments to LangChain's multimodal message format:

```typescript
content = [
  { type: 'text', text: 'Your message' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
]
```

This format is compatible with AWS Bedrock's Claude models via `ChatBedrockConverse`.

## Implementation Files

- **Component**: `web-ui/components/agent/file-upload.tsx`
- **Chat Interface**: `web-ui/components/agent/chat-interface.tsx`
- **API Route**: `web-ui/app/api/chat/route.ts`
- **Agent Configs**: `web-ui/lib/agent/fast-agent.ts`, `web-ui/lib/agent/planning-agent.ts`

## Limitations

- Only image files are currently supported (no PDFs, documents, or videos)
- Images are not persisted in chat history (only in active session)
- Large images may increase response latency
- Token costs increase with image complexity and size

## Future Enhancements

- [ ] PDF document support
- [ ] Persistent image storage in S3
- [ ] Image compression/optimization
- [ ] OCR text extraction
- [ ] Video frame analysis
- [ ] Audio file transcription

## Security Considerations

- Files are validated for type and size before upload
- Base64 encoding prevents direct file system access
- No server-side file storage (memory only)
- Images are not logged or persisted beyond the session

## Troubleshooting

**"File too large" error**
- Reduce image size or resolution
- Use image compression tools
- Maximum size is 5MB per file

**"Only images are supported" error**
- Ensure file type is JPEG, PNG, GIF, or WebP
- Check file extension matches actual file type

**Images not displaying**
- Check browser console for errors
- Verify base64 encoding is valid
- Ensure model supports multimodal inputs

## References

- [AWS Bedrock Multimodal Guide](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
- [LangChain Multimodal Messages](https://js.langchain.com/docs/modules/model_io/chat/multimodal)
- [Claude Vision Capabilities](https://docs.anthropic.com/claude/docs/vision)
