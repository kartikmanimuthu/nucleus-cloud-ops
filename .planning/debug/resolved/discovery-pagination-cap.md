---
status: resolved
trigger: "discovery job has an artificial MAX_PAGES=20 cap that prevents scanning all resources in an AWS account"
created: 2026-04-05T00:00:00Z
updated: 2026-04-05T00:00:00Z
---

## Current Focus

hypothesis: MAX_PAGES=20 constant in scanner.ts artificially caps pagination at 20 pages per service, silently truncating results in large AWS accounts
test: Read scanner.ts to confirm the cap and its usage
expecting: Remove the cap entirely; log total pages scanned per service for operator visibility
next_action: Apply fix — remove MAX_PAGES constant, update do-while loop condition, add page-count log

## Symptoms

expected: Discovery ECS job scans ALL resources in an AWS account across all services (EC2, RDS, SSM, IAM, etc.)
actual: Scan stops after 20 pages per service, silently missing resources in large accounts
errors: No errors — it silently truncates, which is worse
reproduction: Run discovery on an AWS account with >20 pages of resources for any service
started: Added as a Lambda safeguard; job was later moved to ECS where the cap is no longer needed

## Eliminated

- hypothesis: cap might be in a Python file (old Lambda)
  evidence: grep found MAX_PAGES only in workers/src/jobs/discovery/services/scanner.ts
  timestamp: 2026-04-05T00:00:00Z

## Evidence

- timestamp: 2026-04-05T00:00:00Z
  checked: workers/src/jobs/discovery/services/scanner.ts line 10
  found: `const MAX_PAGES = 20; // cap pagination at 20 pages per service to avoid runaway scans`
  implication: Single constant controls all service pagination; removing it unblocks all services at once

- timestamp: 2026-04-05T00:00:00Z
  checked: scanner.ts line 148
  found: `} while (nextToken && pages < MAX_PAGES);`
  implication: Only one usage site — clean removal with no other references

- timestamp: 2026-04-05T00:00:00Z
  checked: scanner.ts lines 130-148 (invokeService pagination loop)
  found: pages counter increments each iteration but is only used for the MAX_PAGES guard; no other logic depends on it
  implication: Can repurpose pages counter for logging total pages scanned per service

## Resolution

root_cause: MAX_PAGES=20 constant in workers/src/jobs/discovery/services/scanner.ts was added as a Lambda timeout safeguard. The discovery job now runs in ECS with no timeout concern, making the cap an artificial truncation that silently omits resources.
fix: Remove MAX_PAGES constant; change loop condition to `while (nextToken)`; add console.log after loop reporting total pages scanned per service/region
verification:
files_changed: [workers/src/jobs/discovery/services/scanner.ts]
