# Kiro Agent Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER REQUEST                                  │
│                         ↓                                        │
│              "Add feature X to the system"                       │
└─────────────────────────────────────────────────────────────────┘
                           ↓
                    ┌──────────────┐
                    │  COMPLEXITY  │
                    │   ANALYSIS   │
                    └──────────────┘
                           ↓
              ┌────────────┴────────────┐
              ↓                         ↓
    ┌─────────────────┐       ┌─────────────────┐
    │   VIBE MODE     │       │  PLANNING MODE  │
    │  (< 4 files)    │       │   (4+ files)    │
    └─────────────────┘       └─────────────────┘
              ↓                         ↓
              │                         │
              │                ┌────────────────┐
              │                │ [PLAN ARTIFACT]│
              │                │  • Subtasks    │
              │                │  • Files       │
              │                │  • Approach    │
              │                │  • Risks       │
              │                └────────────────┘
              │                         ↓
              │                ┌────────────────┐
              │                │ APPROVAL GATE  │
              │                │ "Go ahead?"    │
              │                └────────────────┘
              │                         ↓
    ┌─────────────────┐       ┌─────────────────┐
    │   [INTENT]      │       │ [CODE ARTIFACT] │
    │ One-liner goal  │       │  Subtask 1/N    │
    └─────────────────┘       └─────────────────┘
              ↓                         ↓
    ┌─────────────────┐       ┌─────────────────┐
    │   [CODE]        │       │ [CODE ARTIFACT] │
    │ Implementation  │       │  Subtask 2/N    │
    └─────────────────┘       └─────────────────┘
              ↓                         ↓
              │                         ⋮
              │                         ↓
              │                ┌─────────────────┐
              │                │[VALIDATION]     │
              │                │ Test commands   │
              │                │ Expected output │
              │                └─────────────────┘
              │                         ↓
              │                ┌─────────────────┐
              │                │  Bug found?     │
              │                └─────────────────┘
              │                    ↓         ↓
              │                   Yes       No
              │                    ↓         ↓
              │           ┌────────────┐    │
              │           │[BUG FIX]   │    │
              │           │Self-correct│    │
              │           └────────────┘    │
              │                    ↓         ↓
              ↓                    └─────────┘
    ┌─────────────────┐       ┌─────────────────┐
    │   [DONE]        │       │ [SUMMARY]       │
    │ • What built    │       │ • Implemented   │
    │ • Files changed │       │ • Files changed │
    │ • How to test   │       │ • How it works  │
    │ • Notes         │       │ • How to test   │
    └─────────────────┘       │ • Watch out for │
              ↓               │ • Follow-up     │
              │               └─────────────────┘
              │                         ↓
              └─────────────┬───────────┘
                            ↓
                   ┌────────────────┐
                   │  TASK COMPLETE │
                   └────────────────┘
```

---

## AWS Best Practices Enforcement (Both Modes)

```
┌─────────────────────────────────────────────────────────────────┐
│                    BEFORE CODING                                 │
├─────────────────────────────────────────────────────────────────┤
│  ✅ AWS SDK v3 check (@aws-sdk/client-*)                        │
│  ✅ Cross-account = sts:AssumeRole                              │
│  ✅ DynamoDB schema matches docs/schema-design.md               │
│  ✅ Audit log for resource modifications                        │
│  ✅ CDK changes? Run cdk diff first                             │
│  ✅ Bedrock model: anthropic.claude-3-5-sonnet-20241022-v2:0    │
│  ✅ Lambda: 5 min timeout, 512 MB memory                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Auto-Escalation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    VIBE MODE ACTIVE                              │
└─────────────────────────────────────────────────────────────────┘
                           ↓
              ┌────────────────────────┐
              │  Complexity detected:  │
              │  • 4+ files            │
              │  • Breaking changes    │
              │  • Infrastructure      │
              │  • Arch significant    │
              └────────────────────────┘
                           ↓
              ┌────────────────────────┐
              │  "This one's bigger    │
              │   than a vibe —        │
              │   want me to switch    │
              │   to planning mode?"   │
              └────────────────────────┘
                           ↓
                    ┌──────────┐
                    │   Yes    │
                    └──────────┘
                           ↓
              ┌────────────────────────┐
              │  SWITCH TO PLANNING    │
              │       MODE             │
              └────────────────────────┘
```

---

## Context Loading

```
┌─────────────────────────────────────────────────────────────────┐
│                    AGENT INITIALIZATION                          │
└─────────────────────────────────────────────────────────────────┘
                           ↓
              ┌────────────────────────┐
              │  Load Steering Files:  │
              │  • aws-best-practices  │
              │  • structure           │
              │  • tech                │
              │  • product             │
              └────────────────────────┘
                           ↓
              ┌────────────────────────┐
              │  Load Project Docs:    │
              │  • ARCHITECTURE.md     │
              │  • schema-design.md    │
              └────────────────────────┘
                           ↓
              ┌────────────────────────┐
              │  Load Workflow:        │
              │  • Planning workflow   │
              │    OR                  │
              │  • Vibe workflow       │
              └────────────────────────┘
                           ↓
              ┌────────────────────────┐
              │   AGENT READY          │
              │   Model: Claude 3.5    │
              │   Context: Loaded      │
              └────────────────────────┘
```

---

## Decision Tree

```
                    ┌──────────────┐
                    │ USER REQUEST │
                    └──────────────┘
                           ↓
                    ┌──────────────┐
                    │ How many     │
                    │ files?       │
                    └──────────────┘
                           ↓
              ┌────────────┴────────────┐
              ↓                         ↓
         < 4 files                  4+ files
              ↓                         ↓
    ┌─────────────────┐       ┌─────────────────┐
    │ Breaking        │       │                 │
    │ changes?        │       │  PLANNING MODE  │
    └─────────────────┘       │                 │
              ↓               └─────────────────┘
         ┌────┴────┐
         ↓         ↓
        Yes       No
         ↓         ↓
    ┌─────────┐   │
    │PLANNING │   │
    │  MODE   │   │
    └─────────┘   │
                  ↓
         ┌─────────────────┐
         │ Infrastructure  │
         │ changes?        │
         └─────────────────┘
                  ↓
             ┌────┴────┐
             ↓         ↓
            Yes       No
             ↓         ↓
        ┌─────────┐   │
        │PLANNING │   │
        │  MODE   │   │
        └─────────┘   │
                      ↓
             ┌─────────────────┐
             │   VIBE MODE     │
             └─────────────────┘
```

---

## Artifact Flow (Planning Mode)

```
[PLAN ARTIFACT]
      ↓
User reviews
      ↓
   Feedback?
      ↓
  ┌───┴───┐
  ↓       ↓
 Yes     No
  ↓       ↓
Revise  Approve
  ↓       ↓
  └───┬───┘
      ↓
[CODE ARTIFACT 1/N]
      ↓
[CODE ARTIFACT 2/N]
      ↓
      ⋮
      ↓
[CODE ARTIFACT N/N]
      ↓
[VALIDATION ARTIFACT]
      ↓
   Pass?
      ↓
  ┌───┴───┐
  ↓       ↓
 No      Yes
  ↓       ↓
[BUG]     │
  ↓       │
Fix       │
  ↓       │
  └───┬───┘
      ↓
[SUMMARY ARTIFACT]
      ↓
   DONE
```

---

## Tool Integration

```
┌─────────────────────────────────────────────────────────────────┐
│                    KIRO AGENT ECOSYSTEM                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────┐         ┌────────────────┐                 │
│  │  Planning Mode │         │   Vibe Mode    │                 │
│  └────────────────┘         └────────────────┘                 │
│          ↓                           ↓                          │
│          └───────────┬───────────────┘                          │
│                      ↓                                          │
│          ┌───────────────────────┐                             │
│          │  Steering Files       │                             │
│          │  • AWS Best Practices │                             │
│          │  • Workflows          │                             │
│          │  • Tech Stack         │                             │
│          └───────────────────────┘                             │
│                      ↓                                          │
│          ┌───────────────────────┐                             │
│          │  Project Context      │                             │
│          │  • Architecture       │                             │
│          │  • Schema Design      │                             │
│          │  • Structure          │                             │
│          └───────────────────────┘                             │
│                      ↓                                          │
│          ┌───────────────────────┐                             │
│          │  Claude 3.5 Sonnet    │                             │
│          │  (AWS Bedrock)        │                             │
│          └───────────────────────┘                             │
│                      ↓                                          │
│          ┌───────────────────────┐                             │
│          │  Code Generation      │                             │
│          │  • TypeScript         │                             │
│          │  • AWS SDK v3         │                             │
│          │  • Next.js            │                             │
│          │  • CDK                │                             │
│          └───────────────────────┘                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```
