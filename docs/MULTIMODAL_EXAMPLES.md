# Multimodal Examples

This document provides practical examples of using the image upload feature with the AI agent.

## Example 1: AWS Architecture Review

**Scenario**: You have an AWS architecture diagram and want the agent to review it for best practices.

**Steps**:
1. Click "Attach Images" button
2. Upload your architecture diagram (PNG/JPEG)
3. Type: "Review this AWS architecture for security and scalability issues"
4. Send

**Expected Output**: The agent will analyze the diagram and provide:
- Security recommendations
- Scalability concerns
- Cost optimization suggestions
- High availability improvements

---

## Example 2: CloudWatch Dashboard Analysis

**Scenario**: Your CloudWatch dashboard shows unusual metrics and you need help interpreting them.

**Steps**:
1. Take a screenshot of your CloudWatch dashboard
2. Upload the screenshot
3. Type: "What's wrong with these metrics? The application has been slow since 2pm."
4. Send

**Expected Output**: The agent will:
- Identify anomalies in the metrics
- Correlate timing with the reported issue
- Suggest investigation steps
- Recommend monitoring improvements

---

## Example 3: Error Message Troubleshooting

**Scenario**: You're getting an error in the AWS Console and need help resolving it.

**Steps**:
1. Screenshot the error message
2. Upload the image
3. Type: "How do I fix this IAM permission error?"
4. Send

**Expected Output**: The agent will:
- Parse the error message from the image
- Explain the root cause
- Provide the exact IAM policy needed
- Suggest prevention strategies

---

## Example 4: Infrastructure Comparison

**Scenario**: You want to compare two different infrastructure setups.

**Steps**:
1. Upload both architecture diagrams
2. Type: "Compare these two architectures and recommend which is better for a high-traffic web application"
3. Send

**Expected Output**: The agent will:
- Analyze both architectures
- Compare costs, performance, and reliability
- Provide a recommendation with justification
- Suggest hybrid approaches if applicable

---

## Example 5: Terraform Configuration Review

**Scenario**: You have a screenshot of Terraform code and want a security review.

**Steps**:
1. Screenshot your Terraform configuration
2. Upload the image
3. Type: "Review this Terraform config for security vulnerabilities"
4. Send

**Expected Output**: The agent will:
- Identify security issues (hardcoded secrets, overly permissive policies)
- Suggest secure alternatives
- Recommend Terraform best practices
- Provide corrected code snippets

---

## Example 6: Cost Analysis from Billing Dashboard

**Scenario**: Your AWS billing dashboard shows unexpected costs.

**Steps**:
1. Screenshot the Cost Explorer or billing dashboard
2. Upload the image
3. Type: "Why did my costs spike last week? What services are responsible?"
4. Send

**Expected Output**: The agent will:
- Identify the services causing cost increases
- Explain potential reasons for the spike
- Suggest cost optimization strategies
- Recommend budget alerts and monitoring

---

## Example 7: Network Diagram Validation

**Scenario**: You've designed a VPC network topology and want validation.

**Steps**:
1. Upload your network diagram
2. Type: "Validate this VPC design for a multi-tier application with public and private subnets"
3. Send

**Expected Output**: The agent will:
- Verify subnet configurations
- Check routing table logic
- Validate security group placement
- Suggest improvements for isolation and security

---

## Example 8: Kubernetes Deployment Diagram

**Scenario**: You have a K8s deployment diagram and need optimization advice.

**Steps**:
1. Upload the Kubernetes architecture diagram
2. Type: "How can I optimize this EKS deployment for cost and performance?"
3. Send

**Expected Output**: The agent will:
- Analyze pod distribution and resource allocation
- Suggest node group optimizations
- Recommend autoscaling configurations
- Identify potential single points of failure

---

## Tips for Best Results

### Image Quality
- Use high-resolution screenshots (at least 1280x720)
- Ensure text is readable
- Avoid excessive compression
- Use PNG for diagrams, JPEG for photos

### Prompt Engineering
- Be specific about what you want analyzed
- Provide context (e.g., "This is a production environment")
- Ask focused questions
- Mention any constraints (budget, timeline, compliance)

### Multiple Images
- Upload related images together
- Reference specific images in your prompt ("In the first image...")
- Keep total size under 15MB for best performance

### Follow-up Questions
- Ask for clarification on specific points
- Request code examples or commands
- Ask for alternative approaches
- Request step-by-step implementation guides

---

## Common Use Cases

| Use Case | Image Type | Example Prompt |
|----------|-----------|----------------|
| Architecture Review | Diagram | "Review this architecture for production readiness" |
| Error Debugging | Screenshot | "What's causing this error and how do I fix it?" |
| Cost Analysis | Dashboard | "Analyze these costs and suggest optimizations" |
| Security Audit | Config/Diagram | "Identify security vulnerabilities in this setup" |
| Performance Tuning | Metrics | "Why is performance degrading? See these metrics" |
| Compliance Check | Architecture | "Does this meet SOC2 compliance requirements?" |
| Capacity Planning | Graphs | "Based on these trends, when should I scale?" |
| Incident Response | Logs/Alerts | "Help me troubleshoot this production incident" |

---

## Limitations to Keep in Mind

- **File Size**: Maximum 5MB per image
- **File Types**: Only JPEG, PNG, GIF, WebP supported
- **OCR Accuracy**: Small or blurry text may not be readable
- **Context**: Agent can't access live AWS resources from images alone
- **Persistence**: Images are not saved in chat history after session ends

---

## Advanced Techniques

### Combining Images with Commands

Upload an architecture diagram, then ask the agent to:
```
"Based on this architecture, write a Terraform module to deploy it"
```

The agent can reference the image while generating code.

### Iterative Refinement

1. Upload initial design
2. Get feedback
3. Upload revised design
4. Compare improvements

### Multi-Modal Workflows

1. Upload error screenshot
2. Agent suggests AWS CLI command
3. Upload command output screenshot
4. Agent provides next steps

---

## Troubleshooting

**Image not displaying**
- Check file size (must be under 5MB)
- Verify file type is supported
- Try re-uploading

**Agent can't read text in image**
- Increase screenshot resolution
- Ensure good contrast
- Avoid small fonts
- Try uploading a clearer image

**Slow response times**
- Large images take longer to process
- Compress images before uploading
- Upload fewer images per message

**Incorrect analysis**
- Provide more context in your prompt
- Upload higher quality images
- Ask follow-up questions for clarification
