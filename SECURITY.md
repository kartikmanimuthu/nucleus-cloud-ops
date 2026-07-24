# Security Policy

## Supported Versions

Nucleus Ops is developed on the `master-v1` branch. Security fixes are applied to the
latest release; older tags are not backported.

| Version | Supported          |
| ------- | ------------------ |
| Latest release / `master-v1` | :white_check_mark: |
| Older tags | :x: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in Nucleus Ops,
please follow these steps:

1. **Do NOT create a public GitHub issue.** Security vulnerabilities should be handled
   privately until a fix is available.
2. Report it privately using GitHub's
   [Report a vulnerability](https://github.com/kartikmanimuthu/nucleus-cloud-ops/security/advisories/new)
   flow, or email **kartikmanimuthu@gmail.com**.
3. Include a detailed description, steps to reproduce, the affected version or commit,
   and the potential impact.
4. You will receive an acknowledgement within 48 hours and an estimated timeline for a fix.
5. Once resolved, we will publish a security advisory and credit you for the discovery
   (unless you prefer to stay anonymous).

Please do not run automated scanners against infrastructure you do not own. Because
Nucleus Ops is self-hosted, any deployment you find on the internet belongs to a third
party — test only against your own instance.

## Security Model

A few properties worth knowing when assessing this project:

- **No long-lived AWS credentials.** Cross-account access uses `sts:AssumeRole` to obtain
  temporary credentials at request time.
- **Tenant isolation** is enforced in the data layer via `getTenantClient(tenantId)`, which
  scopes every Prisma query by `tenant_id`. Note that raw `$executeRaw` calls bypass this
  extension and must scope manually — a known sharp edge worth reviewing in contributions.
- **RBAC** is enforced per module with CASL on every mutating API route.
- **Audit logging** records every action that modifies an AWS resource.
- **Agent tool calls** are gated behind human approval unless auto-approve is explicitly
  enabled by the operator.

Thank you for helping keep Nucleus Ops secure.
