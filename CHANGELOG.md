# Changelog

All notable changes to Nucleus Cloud Ops will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Multimodal Support**: File upload functionality for AI agent
  - Upload images (JPEG, PNG, GIF, WebP) alongside text prompts
  - Visual preview of attached images before sending
  - Support for multiple images per message
  - 5MB file size limit per image
  - Inline image display in chat history
  - Compatible with all agent modes (Fast, Planning, Deep)
  - Works with all Claude and Nova models
- New `FileUpload` component for image attachment management
- Comprehensive documentation for multimodal features
- Unit tests for file upload functionality
- Practical examples and use cases

### Changed
- Updated `ChatInterface` to support file attachments
- Enhanced API route to handle multimodal message format
- Modified message rendering to display attached images
- Updated README with multimodal feature information

### Technical Details
- Implements Vercel AI SDK `experimental_attachments` format
- Converts to LangChain multimodal message structure
- Uses base64 encoding for image transmission
- No backend storage (memory only for session)
- Backward compatible with text-only messages

### Documentation
- `docs/MULTIMODAL_SUPPORT.md`: Feature documentation
- `docs/MULTIMODAL_EXAMPLES.md`: Practical usage examples
- `docs/QUICKSTART_MULTIMODAL.md`: Quick start guide
- `docs/IMPLEMENTATION_MULTIMODAL.md`: Implementation details

### Files Modified
- `web-ui/components/agent/chat-interface.tsx`
- `web-ui/app/api/chat/route.ts`
- `README.md`

### Files Added
- `web-ui/components/agent/file-upload.tsx`
- `web-ui/tests/agent/file-upload.test.ts`
- `docs/MULTIMODAL_SUPPORT.md`
- `docs/MULTIMODAL_EXAMPLES.md`
- `docs/QUICKSTART_MULTIMODAL.md`
- `docs/IMPLEMENTATION_MULTIMODAL.md`

## [1.0.0] - 2026-02-28

### Added
- Initial release of Nucleus Cloud Ops
- AWS multi-account management
- Automated resource scheduling (EC2, RDS, ECS)
- AI DevOps agent with LangGraph
- Cost optimization dashboard
- Audit logging and compliance tracking
- Dark/light theme support
- MCP server integration
- Skills-based agent capabilities

### Infrastructure
- AWS CDK deployment
- DynamoDB single-table design
- Lambda scheduler with EventBridge
- ECS Fargate for web UI
- CloudFront distribution
- VPC with public/private subnets

### Security
- Cross-account IAM roles
- Temporary credentials via STS
- DynamoDB encryption at rest
- NextAuth.js authentication
- Cognito integration

---

## Release Notes

### Multimodal Support (Unreleased)

This release introduces powerful multimodal capabilities to the AI agent, enabling visual analysis and troubleshooting workflows.

**Key Benefits**:
- 📸 Upload architecture diagrams for review
- 🐛 Share error screenshots for debugging
- 📊 Analyze CloudWatch dashboards visually
- 🔍 Review Terraform configs from screenshots
- 💰 Investigate cost spikes from billing dashboards

**Use Cases**:
1. Architecture reviews and validation
2. Error message troubleshooting
3. Dashboard metric analysis
4. Infrastructure diagram comparison
5. Security audit from screenshots
6. Cost analysis from billing views
7. Network topology validation
8. Kubernetes deployment optimization

**Supported Models**:
- Claude 4.5 Sonnet, Haiku, Opus
- Claude 4.6 Sonnet, Opus
- Amazon Nova 2 Lite

**Limitations**:
- Images not persisted beyond session
- 5MB file size limit
- Image formats only (no PDFs/videos)
- Increased token costs for multimodal requests

**Migration**:
- No breaking changes
- Backward compatible with existing chats
- No infrastructure updates required
- No environment variables needed

**Documentation**:
- See `docs/MULTIMODAL_SUPPORT.md` for details
- See `docs/MULTIMODAL_EXAMPLES.md` for examples
- See `docs/QUICKSTART_MULTIMODAL.md` for quick start

---

## Upgrade Guide

### To Unreleased (Multimodal Support)

**Frontend**:
```bash
cd web-ui
npm install
npm run build
```

**No Backend Changes Required**:
- No database migrations
- No infrastructure updates
- No environment variables

**Testing**:
```bash
npm test tests/agent/file-upload.test.ts
```

**Deployment**:
```bash
npx cdk deploy WebUIStack
```

---

## Deprecation Notices

None at this time.

---

## Security Advisories

None at this time.

---

## Contributors

- Kartik Manimuthu (@kartikmanimuthu) - Project Lead
- AI Assistant - Multimodal Feature Implementation

---

## Links

- [GitHub Repository](https://github.com/kartikmanimuthu/nucleus-cloud-ops)
- [Documentation](docs/)
- [Issues](https://github.com/kartikmanimuthu/nucleus-cloud-ops/issues)
- [Pull Requests](https://github.com/kartikmanimuthu/nucleus-cloud-ops/pulls)
