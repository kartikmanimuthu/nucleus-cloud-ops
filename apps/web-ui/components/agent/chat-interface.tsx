"use client";

import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SpinnerOverlay } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { buildChatTranscript } from "@/lib/agent/build-chat-transcript";
import { MarkdownContent } from "@/components/ui/markdown-content";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Bot,
  User,
  Trash2,
  Loader2,
  Terminal,
  Send,
  Briefcase,
  Cpu,
  Check,
  X,
  Brain,
  RefreshCw,
  Flag,
  ListChecks,
  Sparkles,
  CalendarPlus,
  Zap,
  Cloud,
  Copy,
  Download,
  Plug,
  Wand2,
  FileText,
  ChevronDown,
  Clock,
  Database,
  BookOpen,
  Maximize2,
  Minimize2,
} from "lucide-react";
import {
  copyToClipboard,
  exportToMarkdown,
  exportToPDF,
} from "@/lib/chat-export";
import { toast } from "sonner";
import { useDistillSkill } from "@/lib/queries/skills";
import { useDistillScheduledTask } from "@/lib/queries/agent-ops-scheduled-tasks";
import { SCHEDULED_TASK_PREFILL_KEY } from "@/components/agent-ops/scheduled-task-dialog";
import { SkillFormDialog } from "@/components/skills/skill-form-dialog";

// Available modes — must stay in sync with the modes the server accepts in
// /api/chat (fast | plan | deep). "deep" runs the extended-thinking agent.
const AGENT_MODES = [
  { id: "fast", label: "Fast (ReAct)" },
  { id: "plan", label: "Plan & Execute" },
  { id: "deep", label: "Deep (Extended Thinking)" },
];

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plan,
  PlanHeader,
  PlanContent,
  PlanStep,
} from "@/components/ai-elements/plan";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";
import {
  Confirmation,
  ConfirmationRequest,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationActions,
  ConfirmationAction,
} from "@/components/ai-elements/confirmation";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ClientAccountService } from "@/lib/client-account-service";
import { UIAccount } from "@/lib/types";
import { useProviderModels } from "@/lib/queries/providers";
import { useKnowledgeBases } from "@/lib/queries/knowledge-base";
import { FileUpload, FileAttachment } from "@/components/agent/file-upload";
import { useRunState } from "@/components/agent/chat/use-run-state";
import { useDecisions } from "@/components/agent/chat/use-decisions";
import { ApprovalBatchCard } from "@/components/agent/chat/approval-batch-card";
import { ClarificationCard } from "@/components/agent/chat/clarification-card";
import { RunRail } from "@/components/agent/chat/run-rail";
import { RunTimeline } from "@/components/agent/chat/run-timeline";

// Phase types matching backend
type AgentPhase =
  | "planning"
  | "execution"
  | "reflection"
  | "revision"
  | "final"
  | "memory_recall"
  | "memory_save"
  | "text";

// Parse phase from content
function parsePhaseFromContent(content: string): {
  phase: AgentPhase;
  cleanContent: string;
} {
  if (content.startsWith("PLANNING_PHASE_START\n")) {
    return {
      phase: "planning",
      cleanContent: content.replace("PLANNING_PHASE_START\n", ""),
    };
  } else if (content.startsWith("EXECUTION_PHASE_START\n")) {
    return {
      phase: "execution",
      cleanContent: content.replace("EXECUTION_PHASE_START\n", ""),
    };
  } else if (content.startsWith("REFLECTION_PHASE_START\n")) {
    return {
      phase: "reflection",
      cleanContent: content.replace("REFLECTION_PHASE_START\n", ""),
    };
  } else if (content.startsWith("REVISION_PHASE_START\n")) {
    return {
      phase: "revision",
      cleanContent: content.replace("REVISION_PHASE_START\n", ""),
    };
  } else if (content.startsWith("FINAL_PHASE_START\n")) {
    return {
      phase: "final",
      cleanContent: content.replace("FINAL_PHASE_START\n", ""),
    };
  } else if (content.startsWith("MEMORY_RECALL_PHASE_START\n")) {
    return {
      phase: "memory_recall",
      cleanContent: content.replace("MEMORY_RECALL_PHASE_START\n", ""),
    };
  } else if (content.startsWith("MEMORY_SAVE_PHASE_START\n")) {
    return {
      phase: "memory_save",
      cleanContent: content.replace("MEMORY_SAVE_PHASE_START\n", ""),
    };
  }
  return { phase: "text", cleanContent: content };
}

// Phase configuration
const phaseConfig: Record<
  AgentPhase,
  {
    icon: React.ElementType;
    label: string;
    borderColor: string;
    bgColor: string;
    textColor: string;
  }
> = {
  planning: {
    icon: ListChecks,
    label: "PLANNING",
    borderColor: "border-blue-500",
    bgColor: "bg-info/100/5",
    textColor: "text-info",
  },
  execution: {
    icon: Cpu,
    label: "EXECUTION",
    borderColor: "border-amber-500",
    bgColor: "bg-amber-500/5",
    textColor: "text-amber-600",
  },
  reflection: {
    icon: Brain,
    label: "REFLECTION",
    borderColor: "border-purple-500",
    bgColor: "bg-purple-500/5",
    textColor: "text-purple-600",
  },
  revision: {
    icon: RefreshCw,
    label: "REVISION",
    borderColor: "border-cyan-500",
    bgColor: "bg-cyan-500/5",
    textColor: "text-cyan-600",
  },
  final: {
    icon: Flag,
    label: "COMPLETE",
    borderColor: "border-green-500",
    bgColor: "bg-success/100/5",
    textColor: "text-success",
  },
  text: {
    icon: Bot,
    label: "RESPONSE",
    borderColor: "border-muted",
    bgColor: "bg-muted/10",
    textColor: "text-muted-foreground",
  },
  memory_recall: {
    icon: BookOpen,
    label: "MEMORY RECALL",
    borderColor: "border-emerald-500",
    bgColor: "bg-emerald-500/5",
    textColor: "text-emerald-600",
  },
  memory_save: {
    icon: Database,
    label: "MEMORY SAVE",
    borderColor: "border-emerald-500",
    bgColor: "bg-emerald-500/5",
    textColor: "text-emerald-600",
  },
};

interface ChatInterfaceProps {
  threadId: string;
  ownerUserId?: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onStatusChange?: (status: "idle" | "streaming" | "error") => void;
  onTitleChange?: (title: string) => void;
}

interface MessageRowProps {
  message: any;
  isLastMessage?: boolean;
  isActivelyStreaming?: boolean;
  renderPhaseBlock: (phase: AgentPhase, content: string, key: string, isActivePhase?: boolean) => React.ReactNode;
  renderToolInvocation: (part: any, messageId: string, index: number) => React.ReactNode;
}

// Extract a plain image URL from a content part, tolerating the several shapes
// history reconstruction can produce (data URL, {url}, or Bedrock {source}).
function partImageUrl(part: any): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  if (typeof part.image === "string") return part.image;
  if (typeof part.url === "string") return part.url;
  if (typeof part.image_url === "string") return part.image_url;
  if (part.image_url && typeof part.image_url.url === "string") return part.image_url.url;
  if (part.source?.data && part.source?.media_type) {
    return `data:${part.source.media_type};base64,${part.source.data}`;
  }
  return undefined;
}

// A "decision carrier" is the empty user message sent to resume a run when the
// user decides a pending approval/clarification batch — the server acts on
// `body.decisions` before reading the last message, so the message itself needs
// no content. Hide it from the transcript so no empty user bubble lingers.
function isEmptyDecisionCarrier(m: any): boolean {
  if (m?.role !== "user") return false;
  const parts: any[] = m.parts || [];
  const hasText =
    parts.some((p: any) => p.type === "text" && (p.text || "").trim().length > 0) ||
    (typeof m.content === "string" && m.content.trim().length > 0);
  const hasAttach =
    (m.experimental_attachments?.length || 0) > 0 ||
    parts.some((p: any) => typeof p.type === "string" && p.type.startsWith("file"));
  return !hasText && !hasAttach;
}

// Render a message whose `content` has no structured `parts` (legacy / history
// rows). If content is a JSON-encoded array of parts, render its text and image
// portions instead of dumping the raw JSON string as markdown text.
function MessageContentFallback({ content }: { content: any }) {
  let value: any = content;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        // Not JSON — render the string as-is below.
      }
    }
  }

  if (Array.isArray(value)) {
    return (
      <>
        {value.map((part: any, idx: number) => {
          if (typeof part === "string") {
            return <MarkdownContent key={idx} content={part} />;
          }
          if (part?.type === "text" && typeof part.text === "string") {
            return <MarkdownContent key={idx} content={part.text} />;
          }
          const imageUrl = partImageUrl(part);
          if (imageUrl) {
            return (
              <img
                key={idx}
                src={imageUrl}
                alt={part?.name || "attachment"}
                className="max-w-xs max-h-48 rounded border object-contain mb-2"
              />
            );
          }
          return null;
        })}
      </>
    );
  }

  return (
    <MarkdownContent
      content={typeof value === "string" ? value : JSON.stringify(value)}
    />
  );
}

const MessageRow = React.memo(function MessageRow({ message, isLastMessage, isActivelyStreaming, renderPhaseBlock, renderToolInvocation }: MessageRowProps) {
  const isUser = message.role === "user";
  const parts: any[] = message.parts || [];
  const attachments = (message as any).experimental_attachments || [];
  
  return (
    <div
      data-testid={isUser ? "user-message" : "ai-message"}
      className={cn(
        "flex gap-3",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {/* AI Avatar */}
      {!isUser && (
        <Avatar className="h-8 w-8 flex-shrink-0 border shadow-sm">
          <AvatarFallback className="bg-gradient-to-br from-primary/80 to-primary text-primary-foreground text-xs">
            <Bot className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      )}

      {/* Message Content */}
      <div
        className={cn(
          "max-w-[85%] rounded-lg p-2.5 text-[13px] overflow-hidden min-w-0",
          isUser
            ? "bg-primary text-primary-foreground ml-auto"
            : "bg-muted/50 border",
        )}
      >
        {/* Render attachments */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((att: any, idx: number) => (
              <img
                key={idx}
                src={att.url}
                alt={att.name}
                className="max-w-xs max-h-48 rounded border object-contain"
              />
            ))}
          </div>
        )}
        
        {/* Render parts.
            Mission Control: assistant messages with structured "work" parts
            (reasoning phases + tool calls) render those inside a threaded
            RunTimeline, with any text parts shown full-width as the answer
            below. Pure-text assistant messages, user messages, and legacy rows
            fall through to the flat loop below (which also drops data-* parts). */}
        {(() => {
          const workParts = parts.filter(
            (p: any) =>
              p.type === "reasoning" ||
              p.type?.startsWith?.("tool-") ||
              (p.toolCallId && p.type !== "text"),
          );
          const textParts = parts.filter((p: any) => p.type === "text");

          const renderTextPart = (part: any, index: number, total: number) => {
            const text = part.text || "";
            if (!text.trim()) return null;
            // While the last text part of the last message is actively streaming,
            // skip the expensive ReactMarkdown + remarkGfm AST parse on every
            // delta. Render as plain pre instead — markdown kicks in automatically
            // once the stream ends and isActivelyStreaming becomes false.
            const isLastPart = index === total - 1;
            const skipMarkdown = isLastMessage && isActivelyStreaming && isLastPart;
            return (
              <div key={`${message.id}-text-${index}`}>
                {skipMarkdown ? (
                  <pre className="whitespace-pre-wrap text-[13px] leading-relaxed font-sans break-words m-0 p-0 bg-transparent border-none">
                    {text}
                  </pre>
                ) : (
                  <MarkdownContent content={text} />
                )}
              </div>
            );
          };

          // Assistant message with work → threaded timeline + full-width answer.
          if (!isUser && workParts.length > 0) {
            return (
              <>
                <RunTimeline
                  parts={workParts}
                  messageId={message.id}
                  isActivelyStreaming={!!isLastMessage && !!isActivelyStreaming}
                  // parsePhaseFromContent narrows to AgentPhase; RunTimeline hands
                  // back the widened string, so cast the phase-block renderer.
                  renderPhaseBlock={renderPhaseBlock as (phase: string, content: string, key: string, isActive?: boolean) => React.ReactNode}
                  renderToolInvocation={renderToolInvocation}
                  parsePhase={parsePhaseFromContent}
                />
                {textParts.map((part: any, index: number) =>
                  renderTextPart(part, index, textParts.length),
                )}
              </>
            );
          }

          // Fallback: flat loop (user messages, pure-text assistant, legacy).
          return (
            <>
              {parts.length > 0 &&
                parts.map((part: any, index: number) => {
                  // Text part
                  if (part.type === "text") {
                    return renderTextPart(part, index, parts.length);
                  }

                  // Reasoning part (contains phase markers)
                  if (part.type === "reasoning") {
                    const { phase, cleanContent } = parsePhaseFromContent(
                      part.text || "",
                    );
                    const isLastReasoningPart = index === parts.map((p: any) => p.type).lastIndexOf("reasoning");
                    const isActivePhase = isLastMessage && isActivelyStreaming && isLastReasoningPart;
                    return renderPhaseBlock(
                      phase,
                      cleanContent,
                      `${message.id}-part-${index}`,
                      isActivePhase,
                    );
                  }

                  // Tool invocation
                  if (part.type === "tool-invocation" || part.toolCallId) {
                    return renderToolInvocation(part, message.id, index);
                  }

                  return null;
                })}

              {/* Fallback for simple content (legacy / history rows without parts) */}
              {parts.length === 0 && message.content && (
                <MessageContentFallback content={message.content} />
              )}
            </>
          );
        })()}
      </div>

      {/* User Avatar */}
      {isUser && (
        <Avatar className="h-8 w-8 flex-shrink-0 border shadow-sm">
          <AvatarFallback className="bg-gradient-to-br from-blue-500 to-blue-600 text-white text-xs">
            <User className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      )}
    </div>
  );
});

// Tool outputs from AWS CLI can exceed 50 KB (describe-instances, list-web-acls, etc.).
// Rendering the full string in the DOM for 30-50 tool calls causes the browser to freeze.
// This constant caps the initially-rendered portion; users can expand on demand.
const TOOL_OUTPUT_TRUNCATE_BYTES = 4096;

const ToolOutputWithTruncation = React.memo(function ToolOutputWithTruncation({
  output,
  isLoading,
  label,
}: {
  output: string | undefined;
  isLoading: boolean;
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!output || output.length <= TOOL_OUTPUT_TRUNCATE_BYTES) {
    return <ToolOutput output={output} isLoading={isLoading} label={label} />;
  }

  const displayOutput = expanded
    ? output
    : output.slice(0, TOOL_OUTPUT_TRUNCATE_BYTES) + "\n… (truncated)";

  return (
    <>
      <ToolOutput output={displayOutput} isLoading={isLoading} label={label} />
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1 mt-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown
          className={cn(
            "w-3 h-3 transition-transform",
            expanded && "rotate-180",
          )}
        />
        {expanded
          ? "Show less"
          : `Show full output (${Math.round(output.length / 1024)} KB)`}
      </button>
    </>
  );
});

function AgentExecutionTimer({ isLoading }: { isLoading: boolean }) {
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isLoading) {
      const start = Date.now();
      setElapsedMs(0);
      interval = setInterval(() => {
        setElapsedMs(Date.now() - start);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isLoading]);

  if (elapsedMs === null) return null;

  const m = Math.floor(elapsedMs / 1000 / 60).toString().padStart(2, '0');
  const s = Math.floor((elapsedMs / 1000) % 60).toString().padStart(2, '0');

  return (
    <span className={cn(
      "ml-2 flex items-center gap-1 font-mono text-[11px]",
      isLoading ? "text-amber-500" : "text-muted-foreground"
    )}>
      <Clock className="w-3 h-3" />
      {m}:{s}
    </span>
  );
}

export function ChatInterface({
  threadId: initialThreadId,
  ownerUserId,
  isFullscreen,
  onToggleFullscreen,
  onStatusChange,
  onTitleChange,
}: ChatInterfaceProps) {
  const [threadId] = useState(initialThreadId);

  // Exit fullscreen on Escape key
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggleFullscreen?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen, onToggleFullscreen]);

  // Configuration state (before conversation starts)
  const [autoApprove, setAutoApprove] = useState(true);
  const [showTools, setShowTools] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  // Models are sourced ONLY from tenant-configured providers (shared TanStack
  // Query hook — no hardcoded Bedrock baseline). Auto-select the first available
  // model so a configured tenant has a sensible default without picking one.
  const { data: availableModels = [] } = useProviderModels();

  useEffect(() => {
    setSelectedModel((prev) =>
      prev && availableModels.some((m) => m.id === prev) ? prev : availableModels[0]?.id ?? "",
    );
  }, [availableModels]);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [agentMode, setAgentMode] = useState("fast");
  const [hasStarted, setHasStarted] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [wasStopped, setWasStopped] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const planStepCacheRef = useRef(new Map<string, string[]>());
  // rAF handle for debounced auto-scroll — cancelled if a new message arrives before the frame fires.
  const scrollRafRef = useRef<number | null>(null);
  // Set once the user sends a message so a slow history fetch can't clobber the
  // optimistic conversation with a stale (or empty) server snapshot.
  const skipHistoryRef = useRef(false);

  // Scroll control state - track if user has manually scrolled up
  const [userHasScrolledUp, setUserHasScrolledUp] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // AWS Account selection state - supports multi-select
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountSearch, setAccountSearch] = useState("");
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const accountDropdownRef = useRef<HTMLDivElement>(null);

  // Skills selection state
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [availableSkills, setAvailableSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillDropdownOpen, setSkillDropdownOpen] = useState(false);

  // Save-as-skill state
  const distillSkill = useDistillSkill();
  const router = useRouter();
  const distillScheduledTask = useDistillScheduledTask();
  const [skillDialogOpen, setSkillDialogOpen] = useState(false);
  const [skillDraft, setSkillDraft] = useState<{ name: string; description: string; tier: string; content: string } | null>(null);

  // MCP server selection state
  const [mcpServers, setMcpServers] = useState<
    Array<{ id: string; name: string; description: string; enabled: boolean }>
  >([]);
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>(
    [],
  );
  const [mcpServersLoading, setMcpServersLoading] = useState(false);
  const [mcpDropdownOpen, setMcpDropdownOpen] = useState(false);
  const [mcpSearch, setMcpSearch] = useState("");
  const mcpDropdownRef = useRef<HTMLDivElement>(null);

  // Knowledge base selection state - empty selection means the server auto-selects
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const { data: knowledgeBases = [] } = useKnowledgeBases();
  const [kbDropdownOpen, setKbDropdownOpen] = useState(false);

  // File attachments state
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);

  // Fetch accounts on mount
  useEffect(() => {
    async function fetchAccounts() {
      try {
        setAccountsLoading(true);
        const { accounts: fetchedAccounts } =
          await ClientAccountService.getAccounts({
            statusFilter: "active",
            connectionFilter: "connected",
            limit: 1000,
          });
        setAccounts(fetchedAccounts);
        console.log("[ChatInterface] Loaded accounts:", fetchedAccounts.length);
      } catch (error) {
        console.error("[ChatInterface] Failed to load accounts:", error);
      } finally {
        setAccountsLoading(false);
      }
    }
    fetchAccounts();
  }, []);

  // Fetch skills on mount
  useEffect(() => {
    async function fetchSkills() {
      try {
        setSkillsLoading(true);
        const res = await fetch("/api/skills");
        if (res.ok) {
          const data = await res.json();
          setAvailableSkills(data.skills || []);
          console.log(
            "[ChatInterface] Loaded skills:",
            data.skills?.length || 0,
          );
        } else {
          console.error("[ChatInterface] Failed to fetch skills:", res.status);
        }
      } catch (error) {
        console.error("[ChatInterface] Failed to load skills:", error);
      } finally {
        setSkillsLoading(false);
      }
    }
    fetchSkills();
  }, []);

  // Fetch MCP servers on mount
  useEffect(() => {
    async function fetchMcpServers() {
      try {
        setMcpServersLoading(true);
        const res = await fetch("/api/mcp-servers");
        if (res.ok) {
          const data = await res.json();
          setMcpServers(data.servers || []);
          console.log(
            "[ChatInterface] Loaded MCP servers:",
            data.servers?.length || 0,
          );
        } else {
          console.error(
            "[ChatInterface] Failed to fetch MCP servers:",
            res.status,
          );
        }
      } catch (error) {
        console.error("[ChatInterface] Failed to load MCP servers:", error);
      } finally {
        setMcpServersLoading(false);
      }
    }
    fetchMcpServers();
  }, []);

  // Get selected account details for API - supports multi-account
  const selectedAccounts = accounts.filter((a) =>
    selectedAccountIds.includes(a.accountId),
  );

  const { messages, sendMessage, status, error, reload, setMessages, addToolResult, stop, regenerate } =
    useChat({
      id: threadId,
      // Batch micro-delta SSE chunks into 50ms windows, reducing ~4000+ renders → ~80-100.
      // Without this, every 1-8 byte token fires a full React reconciliation cycle.
      experimental_throttle: 500,
      transport: new DefaultChatTransport({
        api: "/api/chat",
        body: {
          threadId,
          autoApprove,
          model: selectedModel,
          mode: agentMode,
          accounts:
            selectedAccounts.length > 0
              ? selectedAccounts.map((a) => ({
                  accountId: a.accountId,
                  accountName: a.name,
                }))
              : undefined,
          selectedSkill: selectedSkill || undefined,
          mcpServerIds:
            selectedMcpServerIds.length > 0 ? selectedMcpServerIds : undefined,
          knowledgeBaseIds:
            selectedKbIds.length > 0 ? selectedKbIds : undefined,
        },
      }),
      onFinish: (options) => {
        console.log("[ChatInterface] Chat finished. Final message:", options.message);
        console.log("[ChatInterface] Usage/Options:", options);
      },
      onError: (error) => {
        console.error("[ChatInterface] Chat error:", error);
        // 409 means a duplicate request was blocked by the per-thread lock
        if (error?.message?.includes("409") || (error as any)?.status === 409) {
          console.warn("[ChatInterface] Thread is already processing — duplicate request blocked.");
        }
      },
    }) as any;

  const isLoading = status === 'submitted' || status === 'streaming';

  // ── Mission Control run state ──────────────────────────────────────────────
  // Restored pending-interrupt parts from a reload are appended as a synthetic
  // assistant message so deriveRunState sees them like live stream parts.
  const [restoredParts, setRestoredParts] = useState<any[]>([]);
  const runMessages = useMemo(
    () =>
      restoredParts.length > 0
        ? [...messages, { role: "assistant", parts: restoredParts, id: "restored-interrupt" }]
        : messages,
    [messages, restoredParts],
  );

  // Resume a run by submitting the decided approval/clarification batch.
  // CARRIER MESSAGE: the /api/chat resume path branches on `body.decisions`
  // BEFORE reading the last message, so the message itself carries no content.
  // v7 `sendMessage` accepts an empty-content message (verified in the SDK
  // source: a plain {role,content} object with no `text`/`files` key is pushed
  // verbatim, no rejection), so we send `content: ""` and hide the resulting
  // empty user bubble in rendering via isEmptyDecisionCarrier().
  const submitDecisions = useCallback(
    async (
      decisionBatch: Array<{ toolCallId: string; approved: boolean; reason?: string; answer?: string }>,
    ) => {
      setRestoredParts([]); // decided — the synthetic restore card must not linger
      await sendMessage(
        { role: "user", content: "" } as any, // carrier; server acts on body.decisions
        {
          body: {
            threadId,
            autoApprove,
            model: selectedModel,
            mode: agentMode,
            decisions: decisionBatch,
            accounts:
              selectedAccounts.length > 0
                ? selectedAccounts.map((a) => ({ accountId: a.accountId, accountName: a.name }))
                : undefined,
            selectedSkill: selectedSkill || undefined,
            mcpServerIds:
              selectedMcpServerIds.length > 0 ? selectedMcpServerIds : undefined,
            knowledgeBaseIds:
              selectedKbIds.length > 0 ? selectedKbIds : undefined,
          },
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sendMessage, threadId, autoApprove, selectedModel, agentMode, selectedAccounts, selectedSkill, selectedMcpServerIds, selectedKbIds],
  );

  // Pending ids = approval tools + clarifications; derive in two passes so
  // useDecisions' resolved ids feed back into the displayed pending state.
  const EMPTY_RESOLVED = useMemo(() => new Set<string>(), []);
  const runStateRaw = useRunState(runMessages, EMPTY_RESOLVED);
  const pendingIds = useMemo(
    () => [
      ...(runStateRaw.pendingApproval?.tools.map((t) => t.toolCallId) ?? []),
      ...runStateRaw.pendingClarifications.map((c) => c.toolCallId),
    ],
    [runStateRaw.pendingApproval, runStateRaw.pendingClarifications],
  );
  const { decisions, decide, decideRemaining, resolvedIds } = useDecisions({
    pendingToolCallIds: pendingIds,
    onComplete: submitDecisions,
  });
  const runState = useRunState(runMessages, resolvedIds);

  // Use refs so the effects below only re-run when status/messages change,
  // not when the parent re-renders and passes new inline function references.
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  // Report streaming status to parent for tab indicator
  useEffect(() => {
    if (status === 'streaming' || status === 'submitted') {
      onStatusChangeRef.current?.('streaming');
    } else if (status === 'error') {
      onStatusChangeRef.current?.('error');
    } else {
      onStatusChangeRef.current?.('idle');
    }
  }, [status]);

  // Report title from first user message to parent for tab label
  useEffect(() => {
    const firstUserMsg = messages.find((m: any) => m.role === 'user');
    if (firstUserMsg) {
      const content = typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : 'Chat';
      onTitleChangeRef.current?.(content.slice(0, 50));
    }
  }, [messages]);

  // Derive current agent phase from the most recent reasoning part in the last message.
  // Used to show contextual status text in the loading spinner during execution.
  const currentPhase = useMemo(() => {
    if (!isLoading || messages.length === 0) return "Processing";
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== "assistant") return "Processing";
    const parts = lastMsg.parts || [];
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i] as any;
      if (part.type === "reasoning" && typeof part.text === "string") {
        if (part.text.includes("PLANNING_PHASE_START")) return "Planning";
        if (part.text.includes("EXECUTION_PHASE_START")) return "Executing";
        if (part.text.includes("REFLECTION_PHASE_START")) return "Reflecting";
        if (part.text.includes("REVISION_PHASE_START")) return "Revising";
        if (part.text.includes("FINAL_PHASE_START")) return "Finalizing";
        if (part.text.includes("MEMORY_RECALL_PHASE_START")) return "Recalling";
        if (part.text.includes("MEMORY_SAVE_PHASE_START")) return "Saving";
      }
    }
    return "Processing";
  }, [isLoading, messages]);

  // Fetch conversation history when component mounts (for existing threads).
  // Guarded so a stale load (thread switch / unmount) or a send that races the
  // fetch cannot setState late or clobber the optimistic conversation.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function fetchHistory() {
      console.log(
        "[ChatInterface] Attempting to fetch history for thread:",
        threadId,
      );
      setIsLoadingHistory(true);

      try {
        const historyUrl = ownerUserId
          ? `/api/threads/${threadId}/history?ownerUserId=${encodeURIComponent(ownerUserId)}`
          : `/api/threads/${threadId}/history`;
        const res = await fetch(historyUrl, { signal: controller.signal });
        // Bail if this load is no longer current, or a send has already
        // populated the conversation for this thread.
        if (cancelled || skipHistoryRef.current) return;
        if (res.ok) {
          const data = await res.json();
          if (cancelled || skipHistoryRef.current) return;
          if (data.messages && data.messages.length > 0) {
            console.log(
              "[ChatInterface] Loaded",
              data.messages.length,
              "historical messages",
            );
            setMessages(data.messages);
            setHasStarted(true);
          } else {
            console.log("[ChatInterface] No history found for thread");
          }

          // Mission Control: restore live run-state from the history response so
          // a reload mid-run shows the plan / parked approval card again.
          if (data.pendingInterrupt?.parts?.length) {
            console.log(
              "[ChatInterface] Restoring parked interrupt:",
              data.pendingInterrupt.parts.length,
              "part(s)",
            );
            setRestoredParts(data.pendingInterrupt.parts);
            setHasStarted(true);
          } else if (data.plan?.length) {
            // Reloaded threads carry the final plan even without live data-plan parts.
            setRestoredParts([{ type: "data-plan", data: { steps: data.plan, updatedBy: "history" } }]);
          }
        } else {
          console.warn("[ChatInterface] Failed to fetch history:", res.status);
        }
      } catch (error) {
        if ((error as any)?.name === "AbortError") return;
        console.error("[ChatInterface] Error fetching history:", error);
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    }

    fetchHistory();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [threadId, ownerUserId, setMessages]);

  useEffect(() => {
    if (messages.length > 0) {
      setHasStarted(true);
    }
  }, [messages]);

  const [inputValue, setInputValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Handle scroll events to detect user scroll intent
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const isAtBottom =
      target.scrollHeight - target.scrollTop - target.clientHeight < 50;

    if (isAtBottom) {
      setUserHasScrolledUp(false);
    } else {
      // User has scrolled up - don't auto-scroll
      setUserHasScrolledUp(true);
    }
  };

  // Auto-scroll to bottom only when user hasn't scrolled up.
  // Using requestAnimationFrame batches scroll operations to at most one per frame (~16 ms),
  // avoiding synchronous layout recalculations on every streaming chunk.
  useEffect(() => {
    if (!userHasScrolledUp) {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
        scrollRafRef.current = null;
      });
    }
  }, [messages, userHasScrolledUp]);

  const handleClear = () => {
    setMessages([]);
    setHasStarted(false);
    setWasStopped(false);
  };

  const handleSaveAsSkill = async () => {
    if (messages.length === 0) return;
    const transcript = buildChatTranscript(messages as any);
    try {
      const draft = await distillSkill.mutateAsync({ threadId, transcript });
      setSkillDraft(draft);
      setSkillDialogOpen(true);
    } catch (e) {
      toast.error("Could not create skill from chat", { description: e instanceof Error ? e.message : "Try again" });
    }
  };

  const handleConvertToScheduledTask = async () => {
    if (messages.length === 0) return;
    const transcript = buildChatTranscript(messages as any);
    try {
      const draft = await distillScheduledTask.mutateAsync(transcript);
      sessionStorage.setItem(
        SCHEDULED_TASK_PREFILL_KEY,
        JSON.stringify({ name: draft.name, description: draft.prompt, cronExpression: draft.suggestedCron })
      );
      router.push("/app/agent-ops/scheduled-tasks?prefill=1");
    } catch (e) {
      toast.error("Could not convert chat to a scheduled task", { description: e instanceof Error ? e.message : "Try again" });
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleFormSubmit(e as any);
    }
  };

  const handleEnhancePrompt = async () => {
    if (!inputValue.trim() || isEnhancing || isLoading) return;

    try {
      setIsEnhancing(true);
      const res = await fetch("/api/enhance-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: inputValue,
          model: selectedModel,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to enhance prompt");
      }

      const data = await res.json();
      if (data.enhancedPrompt) {
        setInputValue(data.enhancedPrompt);
      }
    } catch (error) {
      console.error("[ChatInterface] Enhance prompt error:", error);
    } finally {
      setIsEnhancing(false);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading || distillSkill.isPending) return;

    const value = inputValue;
    const files = attachments;
    setInputValue("");
    setAttachments([]);
    setHasStarted(true);
    setWasStopped(false);
    setUserHasScrolledUp(false); // Reset scroll state on new message
    // A send has taken over this thread — an in-flight history load must not
    // overwrite the optimistic user message / streamed response.
    skipHistoryRef.current = true;

    await sendMessage(
      {
        content: value,
        role: "user",
        experimental_attachments: files.length > 0 ? files.map(f => ({
          name: f.name,
          contentType: f.type,
          url: `data:${f.type};base64,${f.data}`
        })) : undefined,
      },
      {
        body: {
          threadId,
          autoApprove,
          model: selectedModel,
          mode: agentMode,
          accounts:
            selectedAccounts.length > 0
              ? selectedAccounts.map((a) => ({
                  accountId: a.accountId,
                  accountName: a.name,
                }))
              : undefined,
          selectedSkill: selectedSkill || undefined,
          mcpServerIds:
            selectedMcpServerIds.length > 0 ? selectedMcpServerIds : undefined,
          knowledgeBaseIds:
            selectedKbIds.length > 0 ? selectedKbIds : undefined,
        },
      },
    );
  };

  const handleStop = () => {
    console.log("[ChatInterface] Stop button clicked, isLoading:", isLoading);
    setWasStopped(true);
    stop();
    console.log("[ChatInterface] Stop called, wasStopped set to true");
  };

  // Handle tool approval - makes explicit API call to resume LangGraph execution
  const handleToolApproval = async (
    toolCallId: string,
    approved: boolean,
    toolName: string,
  ) => {
    console.log(
      `[ChatInterface] Tool ${approved ? "approved" : "rejected"}: ${toolCallId}`,
    );

    // First, update local state via addToolResult (for UI feedback).
    // AI SDK v5 expects { tool, toolCallId, output } — passing the legacy
    // `result` key left the tool output undefined so the approve/reject state
    // wasn't reflected until the follow-up re-stream.
    const result = approved ? "Approved" : "Cancelled by user";
    addToolResult({ tool: toolName, toolCallId, output: result });

    // Then, make explicit API call to resume the graph
    // We send the tool result as a message with role: 'tool'
    await sendMessage(
      {
        role: "tool" as any,
        content: result,
        toolCallId: toolCallId,
      } as any,
      {
        body: {
          threadId,
          autoApprove,
          model: selectedModel,
          mode: agentMode,
          accounts:
            selectedAccounts.length > 0
              ? selectedAccounts.map((a) => ({
                  accountId: a.accountId,
                  accountName: a.name,
                }))
              : undefined,
          selectedSkill: selectedSkill || undefined,
          mcpServerIds:
            selectedMcpServerIds.length > 0 ? selectedMcpServerIds : undefined,
          knowledgeBaseIds:
            selectedKbIds.length > 0 ? selectedKbIds : undefined,
        },
      },
    );
  };

  // Render a phase block
  const renderPhaseBlock = useCallback((
    phase: AgentPhase,
    content: string,
    key: string,
    isActivePhase: boolean = false,
  ) => {
    const config = phaseConfig[phase];
    const Icon = config.icon;

    // Skip rendering if content is just the phase marker with no actual content
    const cleanedContent = content
      .replace(/^(PLANNING_PHASE_START|EXECUTION_PHASE_START|REFLECTION_PHASE_START|REVISION_PHASE_START|FINAL_PHASE_START|MEMORY_RECALL_PHASE_START|MEMORY_SAVE_PHASE_START)\n*/i, '')
      .trim();

    if (!cleanedContent) {
      return null; // Don't render empty phase blocks
    }

    // Parse plan steps from content - handle multiple formats
    // Use cache to avoid re-parsing identical content on every render
    let planSteps: string[] = [];

    if (phase === "planning") {
      const cacheKey = cleanedContent;
      const cached = planStepCacheRef.current.get(cacheKey);
      if (cached) {
        planSteps = cached;
      } else {
        // Try to parse as JSON array first (e.g., ["Step 1: ...", "Step 2: ..."])
        const jsonMatch = cleanedContent.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) {
              planSteps = parsed.map((step: string) =>
                typeof step === "string" ? step : JSON.stringify(step),
              );
            }
          } catch (e) {
            // Not valid JSON, continue to line-by-line parsing
          }
        }

        // If no JSON array found, try line-by-line parsing
        if (planSteps.length === 0) {
          // Match lines starting with number, bullet, dash, or "Step"
          planSteps = cleanedContent.split("\n").filter((line) => {
            const trimmed = line.trim();
            return (
              /^(\d+[\.\):]|\-|\*|•|Step\s*\d+)/i.test(trimmed) &&
              trimmed.length > 5
            );
          });
        }

        // Also check for markdown bold headers like "**Plan Created:**"
        if (planSteps.length === 0 && cleanedContent.includes("**")) {
          // Extract content after headers
          const lines = cleanedContent
            .split("\n")
            .filter((line) => line.trim().length > 0 && !line.includes("**"));
          planSteps = lines;
        }

        planStepCacheRef.current.set(cacheKey, planSteps);
      }
    }

    // Use Plan component for planning phase with steps
    if (phase === "planning" && planSteps.length > 0) {
      return (
        <div key={key} className="w-full mb-2">
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-xs font-semibold border-l-4 rounded-r-md mb-2",
              config.borderColor,
              config.bgColor,
              config.textColor,
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {config.label}
          </div>
          <Plan defaultOpen={true} isStreaming={isActivePhase}>
            <PlanHeader title="Execution Plan" />
            <PlanContent>
              {planSteps.map((step, i) => (
                <PlanStep
                  key={i}
                  number={i + 1}
                  status={i === 0 && isActivePhase ? "active" : "pending"}
                >
                  {/* Clean up step text - remove numbering prefixes */}
                  {step
                    .replace(
                      /^(\d+[\.\):\s]*|Step\s*\d+[:\.\)]*\s*|\-\s*|\*\s*|•\s*)/i,
                      "",
                    )
                    .trim()}
                </PlanStep>
              ))}
            </PlanContent>
          </Plan>
        </div>
      );
    }

    // Use Reasoning component for reflection phase
    if (phase === "reflection") {
      return (
        <div key={key} className="w-full mb-2">
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-xs font-semibold border-l-4 rounded-r-md mb-2",
              config.borderColor,
              config.bgColor,
              config.textColor,
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {config.label}
          </div>
          <Reasoning
            defaultOpen={true}
            isStreaming={isActivePhase}
          >
            <ReasoningTrigger label="Agent Reflection" />
            <ReasoningContent>{cleanedContent}</ReasoningContent>
          </Reasoning>
        </div>
      );
    }

    // Memory phases: collapsible and collapsed by default. Memory recall/save is
    // supplementary context (often large JSON), so keep it compact and consistent
    // with the reflection block instead of a big always-expanded card.
    if (phase === "memory_recall" || phase === "memory_save") {
      return (
        <div key={key} className="w-full mb-2">
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-xs font-semibold border-l-4 rounded-r-md mb-2",
              config.borderColor,
              config.bgColor,
              config.textColor,
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {config.label}
          </div>
          {/* isStreaming is intentionally false so the block stays collapsed by default
              even while streaming live — memory is supplementary, expand on demand. */}
          <Reasoning defaultOpen={false} isStreaming={false}>
            <ReasoningTrigger
              label={phase === "memory_recall" ? "Recalled Memory" : "Saved Memory"}
            />
            <ReasoningContent>{cleanedContent}</ReasoningContent>
          </Reasoning>
        </div>
      );
    }

    // Default phase block for other phases
    return (
      <div
        key={key}
        className={cn(
          "w-full border-l-4 rounded-r-lg overflow-hidden text-xs mb-2 shadow-sm min-w-0",
          config.borderColor,
          config.bgColor,
        )}
      >
        <div
          className={cn(
            "px-3 py-2 font-semibold flex items-center gap-2 border-b",
            `${config.bgColor.replace("/5", "/10")}`,
            config.textColor,
          )}
        >
          <Icon className="w-3.5 h-3.5" />
          {config.label}
          {isActivePhase && (
            <Loader2 className="w-3 h-3 animate-spin ml-auto" />
          )}
        </div>
        <div className="p-3 text-muted-foreground/90 leading-relaxed text-sm overflow-hidden min-w-0 break-words [overflow-wrap:anywhere]">
          <MarkdownContent content={cleanedContent} />
        </div>
      </div>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  // Render tool invocation using enhanced Tool component
  const renderToolInvocation = useCallback((
    part: any,
    messageId: string,
    index: number,
  ) => {
    // Raw tool identifier (as registered on the server) — used for addToolResult.
    // Priority: toolName > name > type ("tool-execute_command" → "execute_command").
    let rawToolName = part.toolName || part.name;
    if (!rawToolName && part.type?.startsWith('tool-')) {
      rawToolName = part.type.replace('tool-', '');
    }
    rawToolName = rawToolName || "tool";

    // Human-friendly name for display (underscores → spaces).
    const toolName = rawToolName.replace(/_/g, ' ');

    const args = part.args || part.input;
    const result = part.result || part.output;
    const state = part.state;

    const isCall = state === "call" || !result;
    // Mission Control owns approval/clarification for tool calls in the current
    // pending batch — suppress the legacy inline Confirmation for those so the
    // decision lives only in the batch/clarification card (avoids double UI).
    const ownedByBatch =
      runState.pendingApproval?.tools.some((t) => t.toolCallId === part.toolCallId) ||
      runState.pendingClarifications.some((c) => c.toolCallId === part.toolCallId);
    // Show approval UI only when: not owned by a card AND not auto-approve AND tool is in "call" state without result
    const isPending = !ownedByBatch && !autoApprove && isCall && !result && !isLoading;

    const hasRealResult =
      !!result && result !== "Approved" && result !== "Cancelled by user";

    // A tool part with no result that is no longer streaming and is not awaiting
    // approval means the run was aborted mid-tool. Surface a terminal state
    // instead of a perpetual "pending" that never resolves (even after reload).
    const isInterrupted = isCall && !result && !isLoading && !isPending;

    // Determine tool state for new component
    const toolState =
      hasRealResult
        ? "complete"
        : isLoading && isCall && !result
          ? "running"
          : isInterrupted
            ? "error"
            : "pending";

    // Determine approval state for Confirmation component
    const approvalState =
      result === "Approved"
        ? "approved"
        : result === "Cancelled by user"
          ? "rejected"
          : isPending
            ? "pending"
            : undefined;

    return (
      <Tool
        key={part.toolCallId || `${messageId}-tool-${index}`}
        state={toolState}
        defaultOpen={showTools || isPending}
        className="mt-2"
      >
        <ToolHeader
          toolName={toolName}
          state={toolState}
          isAuto={autoApprove}
        />
        <ToolContent>
          <ToolInput input={args} label="Input" />

          {/* Approval UI - only when autoApprove is OFF */}
          {isPending && (
            <Confirmation
              approval={{ id: part.toolCallId, state: "pending" }}
              state="pending"
            >
              <ConfirmationRequest>
                The agent wants to execute this {toolName}. Do you approve?
              </ConfirmationRequest>
              <ConfirmationActions>
                <ConfirmationAction
                  variant="outline"
                  onClick={() => handleToolApproval(part.toolCallId, false, rawToolName)}
                >
                  <X className="w-3 h-3 mr-1" />
                  Reject
                </ConfirmationAction>
                <ConfirmationAction
                  variant="default"
                  onClick={() => handleToolApproval(part.toolCallId, true, rawToolName)}
                >
                  <Check className="w-3 h-3 mr-1" />
                  Approve & Run
                </ConfirmationAction>
              </ConfirmationActions>
            </Confirmation>
          )}

          {/* Approved/Rejected status */}
          {approvalState === "approved" && (
            <Confirmation state="approved">
              <ConfirmationAccepted>
                Tool execution approved
              </ConfirmationAccepted>
            </Confirmation>
          )}
          {approvalState === "rejected" && (
            <Confirmation state="rejected">
              <ConfirmationRejected>
                Tool execution rejected by user
              </ConfirmationRejected>
            </Confirmation>
          )}

          {/* Output with loading state — truncated to TOOL_OUTPUT_TRUNCATE_BYTES if large.
              If the run was aborted mid-tool, show a terminal interrupted note. */}
          {isInterrupted ? (
            <ToolOutput
              errorText="Execution interrupted — the run was stopped before this tool returned a result."
              label="Output"
            />
          ) : (
            <ToolOutputWithTruncation
              output={hasRealResult ? result : undefined}
              isLoading={isLoading && isCall && !result}
              label="Output"
            />
          )}
        </ToolContent>
      </Tool>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoApprove, isLoading, handleToolApproval, showTools, runState]);

  // Sample prompts
  const samplePrompts = [
    "Vital check of my ec2 instances",
    "Review the Cost of the AWS Account for the last 3 months and share the key movers and optimization scope",
    "Review my AWS Lambda functions",
  ];

  return (
    <>
    <div className="relative flex h-full w-full overflow-hidden bg-background max-w-[95%] mx-auto border rounded-xl shadow-lg">
      {/* Left: conversation column (header + messages + composer) */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      {distillSkill.isPending && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-xl">
          <SpinnerOverlay label="Generating skill..." />
        </div>
      )}
      {/* Header */}
      <div className="px-4 py-3 border-b bg-gradient-to-r from-primary/10 to-primary/5 flex items-center gap-3">
        <Avatar className="h-9 w-9 border shadow-sm shrink-0">
          <AvatarFallback className="bg-gradient-to-br from-primary to-primary/80 text-primary-foreground font-bold">
            <Bot className="h-5 w-5" />
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0">
          <h2 className="font-semibold flex items-center gap-2">
            AI Ops
            <Sparkles className="w-4 h-4 text-warning" />
          </h2>
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            Plan → Execute → Reflect → Revise
            {autoApprove && (
              <span className="text-success ml-1">(Auto-Approve ON)</span>
            )}
            {selectedSkill && (
              <span className="text-purple-600 ml-1 flex items-center gap-1">
                • <Briefcase className="w-3 h-3" />{" "}
                {availableSkills.find((s) => s.id === selectedSkill)?.name}
              </span>
            )}
            <AgentExecutionTimer isLoading={isLoading} />
          </p>
        </div>

        {/* Compact status strip — mobile only; the full rail is hidden below lg */}
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground lg:hidden">
          {runState.plan.length > 0 && (
            <span>
              plan {runState.plan.filter((s) => s.status === "completed").length}/
              {runState.plan.length}
            </span>
          )}
          {runState.pendingApproval && (
            <span className="text-amber-600">⚠ {runState.pendingApproval.tools.length}</span>
          )}
        </div>

        {onToggleFullscreen && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleFullscreen}
            className="h-8 w-8 shrink-0 lg:ml-auto"
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4" onScrollCapture={handleScroll}>
        <div id={`chat-messages-container-${threadId}`} data-testid="chat-messages-container" className="space-y-4">
          {/* Loading history indicator */}
          {isLoadingHistory && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-primary mb-4" />
              <p className="text-sm text-muted-foreground">
                Loading conversation history...
              </p>
            </div>
          )}

          {/* Initial prompt suggestions when no messages */}
          {messages.length === 0 && !isLoadingHistory && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="w-16 h-16 mb-4 rounded-full bg-primary/10 flex items-center justify-center">
                <Bot className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-lg font-medium mb-2">Start a Conversation</h3>
              <p className="text-sm text-muted-foreground mb-4 max-w-md">
                The agent will plan, execute tools, reflect on results, and
                revise as needed.
              </p>
              <div className="flex flex-wrap gap-2 justify-center">
                {samplePrompts.map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => setInputValue(prompt)}
                    className="px-3 py-1.5 text-xs rounded-full border bg-background hover:bg-muted transition-colors"
                  >
                    💡 {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Render messages — empty decision-carrier messages are hidden */}
          {(() => {
            const rendered = messages.filter((m: any) => !isEmptyDecisionCarrier(m));
            return rendered.map((message: any, msgIndex: number) => (
              <MessageRow
                key={message.id}
                message={message}
                isLastMessage={msgIndex === rendered.length - 1}
                isActivelyStreaming={isLoading}
                renderPhaseBlock={renderPhaseBlock}
                renderToolInvocation={renderToolInvocation}
              />
            ));
          })()}

          {/* Mission Control decision cards — clarifications first, then the
              approval batch. These own the resume decision for their tool calls
              (the inline legacy Confirmation is suppressed for them). */}
          {runState.pendingClarifications.map((c) => (
            <ClarificationCard
              key={c.toolCallId}
              clarification={c}
              onAnswer={(id, answer) => decide(id, { approved: true, answer })}
            />
          ))}
          {runState.pendingApproval && (
            <ApprovalBatchCard
              tools={runState.pendingApproval.tools}
              decisions={decisions}
              onDecide={decide}
              onDecideRemaining={decideRemaining}
            />
          )}

          {/* Loading indicator — shown for the full agent execution lifecycle */}
          {isLoading && (
            <div className="flex gap-3 justify-start">
              <Avatar className="h-8 w-8 flex-shrink-0 border shadow-sm">
                <AvatarFallback className="bg-gradient-to-br from-primary/80 to-primary text-primary-foreground text-xs">
                  <Bot className="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
              <div className="bg-muted/50 border rounded-lg p-3 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{currentPhase}...</span>
              </div>
            </div>
          )}

          {/* Stopped indicator */}
          {wasStopped && !isLoading && (
            <div className="flex gap-3 justify-start">
              <Avatar className="h-8 w-8 flex-shrink-0 border shadow-sm">
                <AvatarFallback className="bg-gradient-to-br from-destructive/80 to-destructive text-destructive-foreground text-xs">
                  <X className="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
              <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 flex items-center gap-2 text-sm text-destructive">
                <span>Execution stopped by user</span>
              </div>
            </div>
          )}

          {/* Error indicator */}
          {status === "error" && (
            <div className="flex gap-3 justify-start">
              <Avatar className="h-8 w-8 flex-shrink-0 border shadow-sm">
                <AvatarFallback className="bg-gradient-to-br from-destructive/80 to-destructive text-destructive-foreground text-xs">
                  <X className="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
              <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 flex flex-col gap-2 text-sm text-destructive">
                <div className="font-semibold flex items-center gap-2">
                  An error occurred
                </div>
                <div className="text-xs break-words max-w-lg mb-1 opacity-90">
                  {error?.message || "Unknown error occurred during the request. Please try again."}
                </div>
                {(reload || regenerate) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start h-7 text-xs border-destructive/30 hover:bg-destructive/10 text-destructive"
                    onClick={() => {
                      // Call reload or regenerate depending on which is available in the SDK
                      const retryFn = reload || regenerate;
                      if (retryFn) {
                        retryFn({
                          body: {
                            threadId,
                            autoApprove,
                            model: selectedModel,
                            mode: agentMode,
                            accounts:
                              selectedAccounts.length > 0
                                ? selectedAccounts.map((a) => ({
                                    accountId: a.accountId,
                                    accountName: a.name,
                                  }))
                                : undefined,
                            selectedSkill: selectedSkill || undefined,
                            mcpServerIds:
                              selectedMcpServerIds.length > 0 ? selectedMcpServerIds : undefined,
                            knowledgeBaseIds:
                              selectedKbIds.length > 0 ? selectedKbIds : undefined,
                          }
                        });
                      }
                    }}
                  >
                    <RefreshCw className="w-3 h-3 mr-1.5" />
                    Retry
                  </Button>
                )}
              </div>
            </div>
          )}

          <div ref={scrollRef} />
        </div>
      </ScrollArea>

      {/* Input Area - Unified Card Design */}
      <div className="p-2 bg-background border-t">
        <form
          onSubmit={handleFormSubmit}
          className="border rounded-xl shadow-sm bg-card focus-within:ring-1 focus-within:ring-ring transition-all"
        >
          {/* Header: Model Selection & AWS Account & Settings */}
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/20">
            <div className="flex items-center gap-2">
              {/* AWS Account Multi-Select with Search */}
              <div className="relative" ref={accountDropdownRef}>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={isLoading || distillSkill.isPending}
                  className="h-7 text-xs border-transparent bg-transparent hover:bg-muted/50 focus:ring-0 gap-1 px-2 w-auto min-w-[150px] justify-start"
                  onClick={() => !isLoading && setAccountDropdownOpen(!accountDropdownOpen)}
                >
                  <div className="flex items-center gap-1.5">
                    <Cloud
                      className={cn(
                        "w-3 h-3",
                        selectedAccountIds.length > 0
                          ? "text-amber-500"
                          : "text-muted-foreground",
                      )}
                    />
                    <span className="truncate max-w-[120px] font-normal">
                      {accountsLoading
                        ? "Loading..."
                        : selectedAccountIds.length === 0
                          ? "Select Accounts"
                          : selectedAccountIds.length === 1
                            ? accounts.find(
                                (a) => a.accountId === selectedAccountIds[0],
                              )?.name || "1 Account"
                            : `${selectedAccountIds.length} Accounts`}
                    </span>
                  </div>
                </Button>
                {accountDropdownOpen && (
                  <div className="absolute left-0 bottom-full mb-1 z-50 w-[320px] rounded-lg border bg-popover shadow-lg">
                    {/* Search Input */}
                    <div className="p-2 border-b">
                      <input
                        type="text"
                        placeholder="Search accounts..."
                        value={accountSearch}
                        onChange={(e) => setAccountSearch(e.target.value)}
                        className="w-full h-8 px-3 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/20"
                        autoFocus
                      />
                    </div>

                    {/* Account List */}
                    <div className="max-h-[300px] overflow-y-auto p-1">
                      {accounts.length === 0 && !accountsLoading && (
                        <p className="text-xs text-muted-foreground p-3 text-center">
                          No accounts available
                        </p>
                      )}
                      {accounts
                        .filter(
                          (account) =>
                            account.name
                              .toLowerCase()
                              .includes(accountSearch.toLowerCase()) ||
                            account.accountId.includes(accountSearch),
                        )
                        .map((account) => (
                          <label
                            key={account.accountId}
                            className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted cursor-pointer text-sm transition-colors"
                          >
                            <Checkbox
                              checked={selectedAccountIds.includes(
                                account.accountId,
                              )}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSelectedAccountIds([
                                    ...selectedAccountIds,
                                    account.accountId,
                                  ]);
                                } else {
                                  setSelectedAccountIds(
                                    selectedAccountIds.filter(
                                      (id) => id !== account.accountId,
                                    ),
                                  );
                                }
                              }}
                              className="h-4 w-4"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium truncate">{account.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {account.accountId}
                              </p>
                            </div>
                          </label>
                        ))}
                      {accounts.filter(
                        (a) =>
                          a.name
                            .toLowerCase()
                            .includes(accountSearch.toLowerCase()) ||
                          a.accountId.includes(accountSearch),
                      ).length === 0 &&
                        accountSearch && (
                          <p className="text-xs text-muted-foreground p-3 text-center">
                            No matching accounts
                          </p>
                        )}
                    </div>

                    {/* Footer Actions */}
                    <div className="p-2 border-t flex justify-between items-center bg-muted/20 rounded-b-lg">
                      <span className="text-xs text-muted-foreground">
                        {selectedAccountIds.length} selected
                      </span>
                      <div className="flex gap-2">
                        {selectedAccountIds.length > 0 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-xs h-7"
                            onClick={() => setSelectedAccountIds([])}
                          >
                            Clear
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="default"
                          size="sm"
                          className="text-xs h-7"
                          onClick={() => {
                            setAccountDropdownOpen(false);
                            setAccountSearch("");
                          }}
                        >
                          Done
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Model Selector with Search */}
              <Popover open={modelDropdownOpen} onOpenChange={setModelDropdownOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={isLoading || distillSkill.isPending}
                    className="h-7 text-xs border-transparent bg-transparent hover:bg-muted/50 focus:ring-0 gap-1 px-2 w-auto min-w-[180px] justify-start"
                  >
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 text-primary" />
                      <span className="truncate max-w-[160px] font-normal">
                        {availableModels.length === 0
                          ? "No providers configured"
                          : availableModels.find((m) => m.id === selectedModel)?.label ??
                            "Select Model"}
                      </span>
                    </div>
                  </Button>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" className="w-[280px] p-0 mb-2">
                  <Command>
                    <CommandInput placeholder="Search models..." />
                    <CommandList>
                      <CommandEmpty>
                        {availableModels.length === 0
                          ? "No LLM providers configured. Add one in Settings → Providers."
                          : "No matching models"}
                      </CommandEmpty>
                      {(() => {
                        // Group label per provider type. Bedrock first, then the rest in a
                        // stable order; any unrecognised provider falls back to its raw key.
                        const PROVIDER_GROUP_LABELS: Record<string, string> = {
                          bedrock: "Bedrock",
                          openai: "OpenAI",
                          anthropic: "Anthropic",
                          ollama: "Ollama",
                          vllm: "vLLM",
                          lmstudio: "LM Studio",
                          litellm: "LiteLLM Gateway",
                          "openai-compatible": "Self-Hosted",
                        };
                        const GROUP_ORDER = [
                          "bedrock",
                          "openai",
                          "anthropic",
                          "ollama",
                          "vllm",
                          "lmstudio",
                          "litellm",
                          "openai-compatible",
                        ];
                        const present = Array.from(new Set(availableModels.map(m => m.provider)));
                        const orderedProviders = [
                          ...GROUP_ORDER.filter(p => present.includes(p)),
                          ...present.filter(p => !GROUP_ORDER.includes(p)),
                        ];
                        return orderedProviders.map((providerKey) => {
                          const models = availableModels.filter(m => m.provider === providerKey);
                          if (models.length === 0) return null;
                          return (
                            <CommandGroup
                              key={providerKey}
                              heading={PROVIDER_GROUP_LABELS[providerKey] ?? providerKey}
                            >
                              {models.map((model) => (
                                <CommandItem
                                  key={model.id}
                                  value={model.label}
                                  onSelect={() => {
                                    setSelectedModel(model.id);
                                    setModelDropdownOpen(false);
                                  }}
                                  className="text-xs"
                                >
                                  <Check
                                    className={cn(
                                      "h-3.5 w-3.5",
                                      model.id === selectedModel ? "opacity-100" : "opacity-0",
                                    )}
                                  />
                                  {model.label}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          );
                        });
                      })()}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {/* Skills Selector with Search */}
              <Popover open={skillDropdownOpen} onOpenChange={setSkillDropdownOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={hasStarted || isLoading || distillSkill.isPending}
                    className="h-7 text-xs border-transparent bg-transparent hover:bg-muted/50 focus:ring-0 gap-1 px-2 w-auto min-w-[180px] justify-start"
                  >
                    <div className="flex items-center gap-1.5">
                      <Briefcase
                        className={cn(
                          "w-3 h-3",
                          selectedSkill
                            ? "text-purple-500"
                            : "text-muted-foreground",
                        )}
                      />
                      <span className="truncate max-w-[140px] font-normal">
                        {selectedSkill
                          ? availableSkills.find((s) => s.id === selectedSkill)
                              ?.name
                          : "Select Agent Skill"}
                      </span>
                    </div>
                  </Button>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" className="w-[280px] p-0 mb-2">
                  <Command>
                    <CommandInput placeholder="Search skills..." />
                    <CommandList>
                      <CommandEmpty>No matching skills</CommandEmpty>
                      <CommandGroup>
                        <CommandItem
                          value="No Skill"
                          onSelect={() => {
                            setSelectedSkill(null);
                            setSkillDropdownOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "h-3.5 w-3.5",
                              !selectedSkill ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <div className="flex flex-col">
                            <span className="font-medium">No Skill</span>
                            <span className="text-xs text-muted-foreground">
                              No specific skill
                            </span>
                          </div>
                        </CommandItem>
                        {availableSkills.map((skill) => (
                          <CommandItem
                            key={skill.id}
                            value={`${skill.name} ${skill.description}`}
                            onSelect={() => {
                              setSelectedSkill(skill.id);
                              setSkillDropdownOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "h-3.5 w-3.5",
                                selectedSkill === skill.id ? "opacity-100" : "opacity-0",
                              )}
                            />
                            <div className="flex flex-col min-w-0">
                              <span className="font-medium">{skill.name}</span>
                              <span className="text-xs text-muted-foreground truncate max-w-[220px]">
                                {skill.description}
                              </span>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {/* Knowledge Base Multi-Select — empty selection means the server auto-selects */}
              <div className="relative border-l pl-2 ml-1">
                <Popover open={kbDropdownOpen} onOpenChange={setKbDropdownOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      disabled={isLoading || distillSkill.isPending}
                      className="h-7 text-xs border-transparent bg-transparent hover:bg-muted/50 focus:ring-0 gap-1 px-2 w-auto min-w-[160px] justify-start"
                    >
                      <div className="flex items-center gap-1.5">
                        <Database
                          className={cn(
                            "w-3 h-3",
                            selectedKbIds.length > 0
                              ? "text-emerald-500"
                              : "text-muted-foreground",
                          )}
                        />
                        <span className="truncate max-w-[140px] font-normal">
                          {selectedKbIds.length === 0
                            ? "Knowledge: All (auto)"
                            : `Knowledge: ${selectedKbIds.length} selected`}
                        </span>
                      </div>
                    </Button>
                  </PopoverTrigger>

                  <PopoverContent
                    side="top"
                    align="start"
                    className="w-[280px] p-0 mb-2"
                  >
                    <div className="max-h-[300px] overflow-y-auto p-1">
                      {knowledgeBases.filter((kb) => kb.status === 'active').length === 0 && (
                        <p className="text-xs text-muted-foreground p-3 text-center">
                          No knowledge bases available
                        </p>
                      )}
                      {knowledgeBases.filter((kb) => kb.status === 'active').map((kb) => (
                        <label
                          key={kb.id}
                          className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted cursor-pointer text-sm transition-colors"
                        >
                          <Checkbox
                            checked={selectedKbIds.includes(kb.id)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedKbIds([...selectedKbIds, kb.id]);
                              } else {
                                setSelectedKbIds(
                                  selectedKbIds.filter((id) => id !== kb.id),
                                );
                              }
                            }}
                            className="h-4 w-4"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate text-xs">
                              {kb.name}
                            </p>
                          </div>
                        </label>
                      ))}
                    </div>
                    <div className="p-2 border-t flex justify-between items-center bg-muted/20 rounded-b-lg">
                      <span className="text-xs text-muted-foreground">
                        {selectedKbIds.length === 0
                          ? "All (auto-select)"
                          : `${selectedKbIds.length} selected`}
                      </span>
                      <div className="flex gap-2">
                        {selectedKbIds.length > 0 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-xs h-7"
                            onClick={() => setSelectedKbIds([])}
                          >
                            Clear
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="default"
                          size="sm"
                          className="text-xs h-7"
                          onClick={() => setKbDropdownOpen(false)}
                        >
                          Done
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>

              {/* MCP Servers Multi-Toggle */}
              {mcpServers.length > 0 && (
                <div className="relative border-l pl-2 ml-1">
                  <Popover
                    open={mcpDropdownOpen}
                    onOpenChange={setMcpDropdownOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        disabled={isLoading || distillSkill.isPending}
                        className="h-7 text-xs border-transparent bg-transparent hover:bg-muted/50 focus:ring-0 gap-1 px-2 w-auto min-w-[140px] justify-start"
                      >
                        <div className="flex items-center gap-1.5">
                          <Plug
                            className={cn(
                              "w-3 h-3",
                              selectedMcpServerIds.length > 0
                                ? "text-green-500"
                                : "text-muted-foreground",
                            )}
                          />
                          <span className="truncate max-w-[120px] font-normal">
                            {mcpServersLoading
                              ? "Loading..."
                              : selectedMcpServerIds.length === 0
                                ? "Select Tools"
                                : selectedMcpServerIds.length === 1
                                  ? mcpServers.find(
                                      (s) => s.id === selectedMcpServerIds[0],
                                    )?.name || "1 Tool"
                                  : `${selectedMcpServerIds.length} Tools`}
                          </span>
                        </div>
                      </Button>
                    </PopoverTrigger>

                    <PopoverContent
                      side="top"
                      align="start"
                      className="w-[280px] p-0 mb-2"
                    >
                      <Command shouldFilter={false}>
                        <CommandInput
                          placeholder="Search tools..."
                          value={mcpSearch}
                          onValueChange={setMcpSearch}
                        />
                        <CommandList>
                          <CommandEmpty>No matching tools</CommandEmpty>
                          <CommandGroup>
                            {mcpServers
                              .filter((server) => server.enabled)
                              .filter(
                                (server) =>
                                  server.name
                                    .toLowerCase()
                                    .includes(mcpSearch.toLowerCase()) ||
                                  server.description
                                    ?.toLowerCase()
                                    .includes(mcpSearch.toLowerCase()),
                              )
                              .map((server) => (
                                <CommandItem
                                  key={server.id}
                                  value={server.id}
                                  onSelect={() => {
                                    if (selectedMcpServerIds.includes(server.id)) {
                                      setSelectedMcpServerIds(
                                        selectedMcpServerIds.filter(
                                          (id) => id !== server.id,
                                        ),
                                      );
                                    } else {
                                      setSelectedMcpServerIds([
                                        ...selectedMcpServerIds,
                                        server.id,
                                      ]);
                                    }
                                  }}
                                >
                                  <Checkbox
                                    checked={selectedMcpServerIds.includes(server.id)}
                                    className="h-4 w-4 pointer-events-none"
                                  />
                                  <div className="flex-1 min-w-0">
                                    <p className="font-medium truncate text-xs">
                                      {server.name}
                                    </p>
                                    {server.description && (
                                      <p className="text-[10px] text-muted-foreground truncate">
                                        {server.description}
                                      </p>
                                    )}
                                  </div>
                                </CommandItem>
                              ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                      <div className="p-2 border-t flex justify-between items-center bg-muted/20 rounded-b-lg">
                        <span className="text-xs text-muted-foreground">
                          {selectedMcpServerIds.length} selected
                        </span>
                        <div className="flex gap-2">
                          {selectedMcpServerIds.length > 0 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-xs h-7"
                              onClick={() => setSelectedMcpServerIds([])}
                            >
                              Clear
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            className="text-xs h-7"
                            onClick={() => {
                              setMcpDropdownOpen(false);
                              setMcpSearch("");
                            }}
                          >
                            Done
                          </Button>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              )}

              <span className="text-[10px] text-muted-foreground hidden sm:inline-block ml-1">
                • {9 + (selectedMcpServerIds.length > 0 ? " + MCP" : "")} tools
              </span>
            </div>

            <div className="flex items-center gap-1">
              {/* Chat Actions */}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                onClick={async () => {
                  const success = await copyToClipboard(messages);
                  if (success) {
                    toast.success("Copied to clipboard");
                  } else {
                    toast.error("Could not copy chat to clipboard");
                  }
                }}
                title="Copy chat to clipboard"
                disabled={messages.length === 0}
              >
                <Copy className="w-3.5 h-3.5" />
              </Button>

              {/* Export dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                    title="Export"
                    disabled={messages.length === 0}
                  >
                    <Download className="w-3.5 h-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    onClick={async () => { await exportToMarkdown(messages, threadId); }}
                    className="gap-2 text-xs cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export as Markdown
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={async () => { await exportToPDF(messages, threadId); }}
                    className="gap-2 text-xs cursor-pointer"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Export as PDF
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Save as skill */}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                onClick={handleSaveAsSkill}
                title="Save chat as a reusable skill"
                aria-label="Save as skill"
                disabled={messages.length === 0 || distillSkill.isPending}
              >
                <Sparkles className="w-3.5 h-3.5" />
              </Button>

              {/* Convert to scheduled task */}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                onClick={handleConvertToScheduledTask}
                title="Convert chat into a recurring scheduled task"
                aria-label="Convert to scheduled task"
                disabled={messages.length === 0 || distillScheduledTask.isPending}
              >
                {distillScheduledTask.isPending
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <CalendarPlus className="w-3.5 h-3.5" />}
              </Button>

              {/* Clear conversation */}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md text-muted-foreground hover:text-destructive"
                onClick={handleClear}
                disabled={isLoading || distillSkill.isPending}
                title="Clear conversation"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          {/* Body: Textarea */}
          <div className="relative">
            <Textarea
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask the agent to plan, execute, reflect, and revise..."
              disabled={isLoading || distillSkill.isPending}
              data-testid="chat-input"
              className="min-h-[80px] max-h-[500px] w-full border-0 focus-visible:ring-0 resize-y overflow-y-auto p-3 text-xs bg-transparent"
            />
          </div>

          {/* File Upload */}
          <div className="px-3">
            <FileUpload
              files={attachments}
              onFilesChange={setAttachments}
              disabled={isLoading || distillSkill.isPending}
            />
          </div>

          {/* Footer: Controls & Send */}
          <div className="flex items-center justify-between px-3 py-2 border-t bg-muted/10">
            <div className="flex items-center gap-4">
              <div className="flex items-center space-x-2">
                <Select value={agentMode} onValueChange={setAgentMode} disabled={isLoading || distillSkill.isPending}>
                  <SelectTrigger className="h-7 text-xs border-transparent bg-transparent hover:bg-muted/50 focus:ring-0 gap-1 px-2 w-auto min-w-[100px]">
                    <SelectValue placeholder="Mode" />
                  </SelectTrigger>
                  <SelectContent>
                    {AGENT_MODES.map((mode) => (
                      <SelectItem
                        key={mode.id}
                        value={mode.id}
                        className="text-xs"
                      >
                        {mode.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="auto-approve-chat"
                  checked={autoApprove}
                  onCheckedChange={(checked) =>
                    setAutoApprove(checked === true)
                  }
                  disabled={isLoading || distillSkill.isPending}
                  className="data-[state=checked]:bg-green-600 data-[state=checked]:border-green-600 h-4 w-4"
                />
                <Label
                  htmlFor="auto-approve-chat"
                  className="text-xs font-medium cursor-pointer text-muted-foreground select-none"
                  title="Read-only tools run without asking. Destructive actions always pause for approval."
                >
                  Auto-approve read-only tools
                </Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="show-tools"
                  checked={showTools}
                  onCheckedChange={(checked) => setShowTools(checked === true)}
                  disabled={isLoading || distillSkill.isPending}
                  className="h-4 w-4 rounded-sm"
                />
                <Label
                  htmlFor="show-tools"
                  className="text-xs font-medium cursor-pointer text-muted-foreground select-none"
                >
                  Show tools
                </Label>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {inputValue.length}/2000
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleEnhancePrompt}
                disabled={
                  !inputValue.trim() || isLoading || isEnhancing || distillSkill.isPending
                }
                className={cn(
                  "h-8 w-8 rounded-full shrink-0 transition-all text-muted-foreground hover:text-primary",
                  isEnhancing && "animate-pulse",
                )}
                title="Enhance prompt using AI"
              >
                {isEnhancing ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : (
                  <Wand2 className="h-4 w-4" />
                )}
              </Button>
              <Button
                type={isLoading ? "button" : "submit"}
                onClick={isLoading ? handleStop : undefined}
                disabled={(!isLoading && !inputValue.trim()) || distillSkill.isPending}
                size="icon"
                data-testid="chat-send-button"
                className={cn(
                  "h-8 w-8 rounded-full shrink-0 transition-all",
                  isLoading
                    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    : "bg-primary hover:bg-primary/90",
                )}
              >
                {isLoading ? (
                  <span className="h-2.5 w-2.5 bg-current rounded-sm" />
                ) : (
                  <Send className="h-4 w-4 ml-0.5" />
                )}
              </Button>
            </div>
          </div>
        </form>
      </div>
      </div>

      {/* Right: run rail — hidden below lg */}
      <div className="hidden w-72 shrink-0 lg:block xl:w-80">
        <RunRail
          runState={runState}
          isStreaming={isLoading}
          context={{
            accountNames: selectedAccounts.map((a) => a.name),
            modelLabel: availableModels.find((m) => m.id === selectedModel)?.label ?? selectedModel,
            skillName: availableSkills.find((s) => s.id === selectedSkill)?.name ?? null,
            toolCount: null,
            kbLabel:
              selectedKbIds.length > 0
                ? `Knowledge: ${selectedKbIds.length} selected`
                : "Knowledge: All (auto)",
          }}
        />
      </div>
    </div>
    <SkillFormDialog
      open={skillDialogOpen}
      onOpenChange={setSkillDialogOpen}
      initialDraft={skillDraft}
      sourceRunId={threadId}
    />
    </>
  );
}