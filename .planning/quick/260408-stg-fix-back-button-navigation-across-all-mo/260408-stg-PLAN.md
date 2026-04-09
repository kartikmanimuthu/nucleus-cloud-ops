---
phase: quick
plan: 260408-stg
type: execute
wave: 1
depends_on: []
files_modified:
  - web-ui/app/app/schedules/[scheduleId]/page.tsx
  - web-ui/app/app/schedules/[scheduleId]/history/[executionId]/page.tsx
autonomous: true
requirements: [NAV-01]
must_haves:
  truths:
    - "Schedule execution history back link navigates to /app/schedules/{id} (not /schedules/{id})"
    - "Schedule detail edit link navigates to /app/schedules/{id}/edit using schedule.id (not schedule.name)"
  artifacts:
    - path: "web-ui/app/app/schedules/[scheduleId]/history/[executionId]/page.tsx"
      provides: "Corrected back links with /app prefix"
    - path: "web-ui/app/app/schedules/[scheduleId]/page.tsx"
      provides: "Corrected edit link with /app prefix and schedule.id"
  key_links:
    - from: "history/[executionId]/page.tsx"
      to: "/app/schedules/[scheduleId]"
      via: "Link href"
      pattern: "href=.*`/app/schedules/"
    - from: "[scheduleId]/page.tsx"
      to: "/app/schedules/[scheduleId]/edit"
      via: "Link href"
      pattern: "href=.*`/app/schedules/.*schedule\\.id.*edit`"
---

<objective>
Fix 3 broken Link hrefs in the schedules module that cause 404 errors by navigating to `/schedules/...` instead of `/app/schedules/...`.

Purpose: Users clicking back/edit links on schedule detail and execution history pages get 404s because the `/app` prefix is missing from href paths.
Output: All schedule navigation links use correct `/app/schedules/...` paths with proper IDs.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@web-ui/app/app/schedules/[scheduleId]/page.tsx
@web-ui/app/app/schedules/[scheduleId]/history/[executionId]/page.tsx
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fix all 3 broken Link hrefs in schedules module</name>
  <files>web-ui/app/app/schedules/[scheduleId]/history/[executionId]/page.tsx, web-ui/app/app/schedules/[scheduleId]/page.tsx</files>
  <action>
Fix 3 broken Link hrefs:

1. `web-ui/app/app/schedules/[scheduleId]/history/[executionId]/page.tsx` line ~130:
   - Change: `href={`/schedules/${scheduleId}`}`
   - To: `href={`/app/schedules/${encodeURIComponent(scheduleId)}`}`
   - Also add encodeURIComponent for safety

2. `web-ui/app/app/schedules/[scheduleId]/history/[executionId]/page.tsx` line ~156:
   - Change: `href={`/schedules/${encodeURIComponent(scheduleId)}`}`
   - To: `href={`/app/schedules/${encodeURIComponent(scheduleId)}`}`

3. `web-ui/app/app/schedules/[scheduleId]/page.tsx` line ~263:
   - Change: `href={`/schedules/${encodeURIComponent(schedule.name)}/edit`}`
   - To: `href={`/app/schedules/${encodeURIComponent(schedule.id)}/edit`}`
   - Two fixes: add `/app` prefix AND use `schedule.id` instead of `schedule.name`

After fixing, run a comprehensive grep to confirm zero remaining broken hrefs:
`grep -rn 'href={\`/schedules/' web-ui/app/app/` should return 0 results.
`grep -rn 'href={\`/app/schedules/' web-ui/app/app/` should show only correct paths.
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration && grep -rn 'href={`/schedules/' web-ui/app/app/ | grep -v '/app/schedules/' ; echo "EXIT:$?"</automated>
  </verify>
  <done>All 3 Link hrefs fixed: two in execution history page use `/app/schedules/${encodeURIComponent(scheduleId)}`, one in schedule detail page uses `/app/schedules/${encodeURIComponent(schedule.id)}/edit`. Zero remaining broken hrefs without `/app` prefix.</done>
</task>

</tasks>

<verification>
- `grep -rn 'href={` + backtick + `/schedules/' web-ui/app/app/` returns 0 matches (no broken links remain)
- `grep -rn 'href={` + backtick + `/app/schedules/' web-ui/app/app/` shows only correct paths with `/app` prefix
- `cd web-ui && npm run lint` passes with no new errors
</verification>

<success_criteria>
All schedule module navigation links (back buttons, edit links) route to `/app/schedules/...` paths. No 404 errors when clicking back or edit from schedule detail or execution history pages.
</success_criteria>

<output>
After completion, create `.planning/quick/260408-stg-fix-back-button-navigation-across-all-mo/260408-stg-SUMMARY.md`
</output>
