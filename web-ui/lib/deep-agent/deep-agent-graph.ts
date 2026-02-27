// ============================================================================
// Deep Agent Module — Core Graph
//
// Uses the `deepagents` npm package natively with all features:
//   - 3 specialized SubAgents (aws-ops, research, code-iac)
//   - CompositeBackend: StateBackend (short-term) + StoreBackend @ /memories/
//   - HITL via interruptOn with per-tool approve/edit/reject granularity
//   - Skills auto-loading (all skills when none explicitly selected)
//   - Long-term memory persisted via MongoStore
//   - MCP tools merged into executor toolset
//
// This file is fully isolated from the existing planning-agent.ts / fast-agent.ts.
// ============================================================================

import { ChatBedrockConverse } from '@langchain/aws';
import {
    createDeepAgent,
    CompositeBackend,
    StateBackend,
    StoreBackend,
    type FileData,
} from 'deepagents';
import { InMemoryStore, MemorySaver } from '@langchain/langgraph';
import * as fs from 'fs';
import * as path from 'path';

import {
    getAwsCredentialsTool,
    listAwsAccountsTool,
} from '../agent/tools';
import { getActiveMCPTools } from '../agent/agent-shared';
import { getMongoClient } from './db/mongo-client';
import { SafeMongoDBSaver } from './db/safe-mongo-saver';
import { mongoStore } from './db/memory-store';
import { DeepAgentConfig } from './types';

// ---------------------------------------------------------------------------
// Skills Loader for deepagents FileData format
// ---------------------------------------------------------------------------

const SKILLS_DIR = path.join(process.cwd(), 'lib', 'agent', 'skills');

function createFileData(content: string): FileData {
    const now = new Date().toISOString();
    return {
        content: content.split('\n'),
        created_at: now,
        modified_at: now,
    };
}

/**
 * Load skill files from disk into deepagents FileData format.
 * Returns { files: Record<virtualPath, FileData>, skillPaths: string[] }
 */
function loadSkillFiles(selectedSkills?: string[]): {
    files: Record<string, FileData>;
    skillPaths: string[];
} {
    const files: Record<string, FileData> = {};
    const skillPaths: string[] = [];

    try {
        if (!fs.existsSync(SKILLS_DIR)) {
            console.warn('[DeepAgent] Skills directory not found:', SKILLS_DIR);
            return { files, skillPaths };
        }

        const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        // If selectedSkills is empty/undefined, auto-load ALL skills
        const skillsToLoad =
            selectedSkills && selectedSkills.length > 0 ? selectedSkills : skillDirs;

        for (const skillId of skillsToLoad) {
            const skillFilePath = path.join(SKILLS_DIR, skillId, 'SKILL.md');
            if (!fs.existsSync(skillFilePath)) continue;

            const content = fs.readFileSync(skillFilePath, 'utf-8');
            const virtualPath = `/skills/${skillId}/SKILL.md`;
            files[virtualPath] = createFileData(content);
        }

        // All loaded skill directories use a single top-level /skills/ path
        if (Object.keys(files).length > 0) {
            skillPaths.push('/skills/');
        }

        console.log(
            `[DeepAgent] Loaded ${Object.keys(files).length} skill file(s) from:`,
            skillsToLoad,
        );
    } catch (err) {
        console.error('[DeepAgent] Error loading skills:', err);
    }

    return { files, skillPaths };
}

// ---------------------------------------------------------------------------
// Account context injection for system prompt
// ---------------------------------------------------------------------------

function buildAccountContext(config: DeepAgentConfig): string {
    const { accounts, accountId, accountName } = config;

    if (accounts && accounts.length > 0) {
        const list = accounts
            .map(a => `  - ${a.accountName || a.accountId} (ID: ${a.accountId})`)
            .join('\n');
        return `\n\n## AWS Account Context\nYou are operating across ${accounts.length} AWS account(s):\n${list}\n\nFor EACH account:\n1. Call get_aws_credentials with the accountId to create a session profile\n2. Use --profile <profileName> with ALL subsequent AWS CLI commands\n3. Label outputs with account name/ID for clarity`;
    }

    if (accountId) {
        return `\n\n## AWS Account Context\nYou are operating in AWS account: ${accountName || accountId} (ID: ${accountId}).\nBefore any AWS CLI commands, call get_aws_credentials with accountId="${accountId}" to get a profile\nand use --profile <profileName> with ALL subsequent commands.`;
    }

    return `\n\n## AWS Account Discovery\nNo explicit account provided. If AWS operations are needed:\n1. Call list_aws_accounts to discover available accounts\n2. Fuzzy-match the user's account name/ID against the list\n3. Call get_aws_credentials with the matched accountId\n4. Use --profile <profileName> with all CLI commands`;
}

// ---------------------------------------------------------------------------
// Main agent factory
// ---------------------------------------------------------------------------

export async function createDeepAgentGraph(config: DeepAgentConfig) {
    const {
        model: modelId,
        autoApprove,
        selectedSkills,
        mcpServerIds,
        tenantId,
    } = config;

    // --- Model ---
    const model = new ChatBedrockConverse({
        region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1',
        model: modelId,
        maxTokens: 8192,
        temperature: 0,
        streaming: true,
    });

    // --- MongoDB Checkpointer (deep-agent-specific, avoids DynamoDB schema conflicts) ---
    let agentCheckpointer: any;
    if (process.env.MONGODB_URI) {
        try {
            const mongoClient = await getMongoClient();
            agentCheckpointer = new SafeMongoDBSaver({
                client: mongoClient as any,
                dbName: process.env.DEEP_AGENT_DB_NAME || 'nucleus_deep_agent',
                checkpointCollectionName: 'checkpoints',
                checkpointWritesCollectionName: 'checkpoint_writes',
            });
            console.log('[DeepAgent] Using MongoDB checkpointer');
        } catch (err) {
            console.warn('[DeepAgent] MongoDB checkpointer init failed, falling back to MemorySaver:', err);
            agentCheckpointer = new MemorySaver();
        }
    } else {
        agentCheckpointer = new MemorySaver();
    }

    // --- Tools ---
    const baseTools = [
        getAwsCredentialsTool,
        listAwsAccountsTool,
    ];

    const mcpTools = await getActiveMCPTools(mcpServerIds, tenantId);
    if (mcpTools.length > 0) {
        console.log(`[DeepAgent] Loaded ${mcpTools.length} MCP tool(s)`);
    }

    // Deduplicate tools by name (MCP servers might provide tools with the same names as base tools)
    const allToolsMap = new Map();
    for (const t of [...baseTools, ...mcpTools]) {
        allToolsMap.set(t.name, t);
    }
    const allTools = Array.from(allToolsMap.values());

    // --- Skills ---
    const { files: skillFiles, skillPaths } = loadSkillFiles(selectedSkills);

    // --- Account context for system prompt ---
    const accountContext = buildAccountContext(config);

    // --- System prompt ---
    const systemPrompt = `You are an elite AI DevOps and Cloud Operations engineer powered by Deep Agent technology. You have deep expertise across AWS services, infrastructure as code, DevOps tooling, and site reliability engineering.

## Core Identity
You plan comprehensively before acting, delegate specialized work to subagents, and maintain a persistent to-do list to track progress across complex multi-step tasks.

## Workflow
1. **Understand** — Fully parse the user's request before taking any action
2. **Plan** — Create a structured execution plan using write_todos
3. **Delegate** — Use specialized subagents for domain-specific work:
   - \`aws-ops\` — AWS resource management, CLI operations, account work
   - \`research\` — Investigation, documentation lookup, analysis
   - \`code-iac\` — Terraform, Ansible, Dockerfile, scripts, IaC
4. **Execute** — Run tools directly for cross-cutting tasks
5. **Verify** — Confirm outcomes, update todos, report findings

## Memory System
- **Short-term** (thread-scoped): Write working notes, drafts, intermediate results to paths like /notes.txt
- **Long-term** (cross-thread): Write preferences, recurring knowledge, reusable configs to /memories/*.txt — these persist across all conversations

## Response Discipline
- Always use --output json and --profile <profile> with AWS CLI
- Run describe/list before any mutation; use --dry-run or terraform plan where supported
- Be precise — include resource IDs, account names, metric values
- Lead with the answer or first action, not a restatement
${accountContext}`;

    // --- SubAgents ---
    const awsOpsSubagent = {
        name: 'aws-ops',
        description:
            'Specialized AWS operations agent. Use for: EC2/ECS/RDS/Lambda/S3/IAM management, AWS CLI execution, account-specific queries, CloudWatch metrics, cost analysis, and any AWS service management.',
        systemPrompt: `You are an expert AWS cloud engineer.
Capabilities: EC2, ECS, EKS, RDS, Lambda, S3, IAM, VPC, CloudWatch, CloudTrail, Route53, ALB/NLB, SQS, SNS, DynamoDB, SSM, Secrets Manager, Cost Explorer, Auto Scaling.

ALWAYS:
- Call get_aws_credentials(accountId) first and use --profile <profile> in all CLI commands
- Use --output json for all AWS CLI commands
- Run describe/list before any mutation
- Use --dry-run where supported before destructive actions
- Include resource IDs and account names in outputs${accountContext}`,
        tools: allTools,
        model,
    };

    const researchSubagent = {
        name: 'research',
        description:
            'Specialized research and analysis agent. Use for: investigating AWS configurations, reading documentation, analyzing logs and metrics, performing root cause analysis, and providing detailed technical reports.',
        systemPrompt: `You are a senior cloud infrastructure researcher and analyst.
Your role: gather information, analyze data, identify patterns, and produce clear, evidence-backed findings.
- Read files and logs carefully; quote relevant sections in your findings
- Cross-reference multiple data sources before drawing conclusions
- Structure findings as: Summary → Evidence → Analysis → Recommendations
- Use exact values (numbers, IDs, timestamps) in your reports`,
        tools: allTools,
        model,
    };

    const codeIacSubagent = {
        name: 'code-iac',
        description:
            'Specialized Infrastructure-as-Code and scripting agent. Use for: writing/reviewing Terraform, CloudFormation, Ansible, Dockerfiles, shell scripts, CI/CD pipelines, and any IaC or automation code.',
        systemPrompt: `You are a senior DevOps engineer specializing in Infrastructure as Code.
Expertise: Terraform (AWS provider), Ansible, CloudFormation, Dockerfiles, GitHub Actions, bash scripting.

Standards:
- Terraform: use proper variable definitions, outputs, and state management; run terraform plan before apply
- Ansible: idempotent playbooks, proper handlers, vault for secrets
- Docker: multi-stage builds, non-root users, minimal base images
- Scripts: proper error handling, logging, and cleanup traps
- Always validate before committing (terraform validate, shellcheck, yamllint)`,
        tools: allTools,
        model,
    };

    // --- HITL configuration ---
    // Mutation tools require approval unless autoApprove is enabled.
    // read-only tools never interrupt.
    const interruptOn: any = autoApprove
        ? undefined
        : {
            execute_command: { allowedDecisions: ['approve', 'edit', 'reject'] },
            write_file: { allowedDecisions: ['approve', 'reject'] },
            edit_file: { allowedDecisions: ['approve', 'edit', 'reject'] },
        };

    // --- Long-term memory store ---
    // Use MongoStore in production, InMemoryStore as fallback
    const store = process.env.MONGODB_URI
        ? (mongoStore as unknown as InstanceType<typeof InMemoryStore>)
        : new InMemoryStore();

    // --- Agent construction ---
    const agent = await createDeepAgent({
        model,
        tools: allTools,
        systemPrompt,
        subagents: [awsOpsSubagent, researchSubagent, codeIacSubagent],
        checkpointer: agentCheckpointer,
        store,
        backend: (cfg: { state: unknown; store?: unknown }) =>
            new CompositeBackend(
                new StateBackend(cfg as any),
                { '/memories/': new StoreBackend(cfg as any) },
            ),
        skills: skillPaths,
        ...(interruptOn ? { interruptOn } : {}),
    });

    return { agent, skillFiles };
}
