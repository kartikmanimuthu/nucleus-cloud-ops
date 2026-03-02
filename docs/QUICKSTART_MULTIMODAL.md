# Quick Start: Using Multimodal Features

## For End Users

### Upload an Image

1. Navigate to the AI Agent page (`/agent`)
2. Below the text input, click **"Attach Images"**
3. Select one or more images (JPEG, PNG, GIF, WebP)
4. See preview thumbnails appear
5. Type your question about the images
6. Click Send

### Example Prompts

```
[Upload AWS architecture diagram]
"Review this architecture for security best practices"
```

```
[Upload error screenshot]
"What's causing this error and how do I fix it?"
```

```
[Upload CloudWatch dashboard]
"Analyze these metrics and identify anomalies"
```

### Remove an Image

- Hover over the image preview
- Click the **X** button in the top-right corner

---

## For Developers

### Testing Locally

```bash
cd web-ui
npm run dev
```

Navigate to `http://localhost:3000/agent` and test the upload feature.

### Running Tests

```bash
cd web-ui
npm test tests/agent/file-upload.test.ts
```

### Code Structure

```
web-ui/
├── components/agent/
│   ├── file-upload.tsx          # Upload component
│   └── chat-interface.tsx       # Main chat UI
├── app/api/chat/
│   └── route.ts                 # API handler
└── lib/agent/
    ├── fast-agent.ts            # Fast mode agent
    └── planning-agent.ts        # Planning mode agent
```

### Adding New File Types

Edit `web-ui/components/agent/file-upload.tsx`:

```typescript
const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png", 
  "image/gif",
  "image/webp",
  "application/pdf", // Add PDF support
];
```

### Changing Size Limit

Edit `web-ui/components/agent/file-upload.tsx`:

```typescript
const MAX_FILE_SIZE = 10 * 1024 * 1024; // Change to 10MB
```

### Custom Validation

```typescript
const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const selectedFiles = Array.from(e.target.files || []);
  
  for (const file of selectedFiles) {
    // Add custom validation
    if (file.name.includes('sensitive')) {
      setError('Sensitive files not allowed');
      continue;
    }
    
    // ... rest of validation
  }
};
```

### Accessing Attachments in Agent

The attachments are automatically converted to multimodal format:

```typescript
// In fast-agent.ts or planning-agent.ts
// No changes needed - ChatBedrockConverse handles it automatically

// The message content will be:
// [
//   { type: 'text', text: 'User message' },
//   { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
// ]
```

### Custom Processing

To add custom image processing in the API route:

```typescript
// In app/api/chat/route.ts

if ((m as any).experimental_attachments?.length > 0) {
  const attachments = (m as any).experimental_attachments;
  
  // Custom processing
  for (const att of attachments) {
    // Compress image
    // Extract metadata
    // Scan for malware
    // etc.
  }
  
  // ... rest of conversion
}
```

---

## Troubleshooting

### Images Not Uploading

**Check browser console**:
```javascript
// Should see:
[FileUpload] Uploaded: screenshot.png 1234567 image/png
```

**Verify file constraints**:
- File type in allowed list
- File size under 5MB
- Valid image file (not corrupted)

### Images Not Displaying

**Check message payload**:
```javascript
console.log(message.experimental_attachments);
// Should show array of attachments
```

**Verify base64 encoding**:
```javascript
// URL should start with: data:image/png;base64,
```

### API Errors

**Check API logs**:
```bash
# In terminal running dev server
[API] Processing multimodal message with 2 images
```

**Verify LangChain conversion**:
```typescript
// Should create content array with text + image_url objects
```

### Model Not Supporting Images

**Verify model ID**:
```typescript
// These support multimodal:
"global.anthropic.claude-sonnet-4-5-20250929-v1:0"  ✅
"global.anthropic.claude-haiku-4-5-20251001-v1:0"   ✅
"global.amazon.nova-2-lite-v1:0"                     ✅
```

---

## Performance Tips

### Optimize Images Before Upload

```bash
# Using ImageMagick
convert input.png -resize 1920x1080 -quality 85 output.jpg

# Using ffmpeg
ffmpeg -i input.png -vf scale=1920:-1 output.jpg
```

### Compress in Browser

```typescript
// Add to file-upload.tsx
async function compressImage(file: File): Promise<File> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  
  return new Promise((resolve) => {
    img.onload = () => {
      canvas.width = Math.min(img.width, 1920);
      canvas.height = Math.min(img.height, 1080);
      ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      canvas.toBlob((blob) => {
        resolve(new File([blob!], file.name, { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.85);
    };
    
    img.src = URL.createObjectURL(file);
  });
}
```

### Lazy Load Images

```typescript
// In chat-interface.tsx
<img
  src={att.url}
  alt={att.name}
  loading="lazy"
  className="max-w-xs max-h-48 rounded border object-contain"
/>
```

---

## Integration Examples

### With Custom Tools

```typescript
// Create a tool that analyzes uploaded images
const analyzeImageTool = tool(
  async ({ imageUrl }) => {
    // Custom image analysis logic
    return "Analysis results...";
  },
  {
    name: "analyze_image",
    description: "Analyze an uploaded image",
    schema: z.object({
      imageUrl: z.string(),
    }),
  }
);
```

### With External APIs

```typescript
// Send image to external service
const response = await fetch('https://api.example.com/analyze', {
  method: 'POST',
  body: JSON.stringify({
    image: base64Data,
    prompt: userMessage,
  }),
});
```

### With S3 Storage

```typescript
// Save image to S3 for persistence
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: 'us-east-1' });

async function saveToS3(attachment: FileAttachment) {
  const buffer = Buffer.from(attachment.data, 'base64');
  
  await s3.send(new PutObjectCommand({
    Bucket: 'nucleus-ops-images',
    Key: `${Date.now()}-${attachment.name}`,
    Body: buffer,
    ContentType: attachment.type,
  }));
}
```

---

## Best Practices

### Security
- ✅ Validate file types on both client and server
- ✅ Enforce size limits
- ✅ Sanitize file names
- ✅ Scan for malware (future enhancement)
- ✅ Use HTTPS for transmission

### Performance
- ✅ Compress images before upload
- ✅ Use appropriate image formats
- ✅ Lazy load images in chat history
- ✅ Implement pagination for image-heavy chats
- ✅ Cache processed images

### User Experience
- ✅ Show upload progress
- ✅ Display clear error messages
- ✅ Provide image previews
- ✅ Allow easy removal of attachments
- ✅ Support drag-and-drop (future)

### Cost Optimization
- ✅ Warn users about token costs
- ✅ Suggest image compression
- ✅ Limit number of images per message
- ✅ Use cheaper models for simple tasks
- ✅ Cache analysis results

---

## Next Steps

1. **Test the feature**: Upload various images and test different scenarios
2. **Review documentation**: Read `MULTIMODAL_SUPPORT.md` for details
3. **Check examples**: See `MULTIMODAL_EXAMPLES.md` for use cases
4. **Run tests**: Execute `npm test` to verify functionality
5. **Provide feedback**: Report issues or suggest improvements

---

## Support

- **Documentation**: `/docs/MULTIMODAL_SUPPORT.md`
- **Examples**: `/docs/MULTIMODAL_EXAMPLES.md`
- **Tests**: `/web-ui/tests/agent/file-upload.test.ts`
- **Issues**: Create a GitHub issue with the `multimodal` label

---

**Happy coding! 🚀**
