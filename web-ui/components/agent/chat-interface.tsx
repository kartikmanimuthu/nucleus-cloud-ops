"use client";

import { useChat } from "@ai-sdk/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
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
  Settings,
  Zap,
  Cloud,
  Copy,
  Download,
  Plug,
  Wand2,
  FileText,
  ChevronDown,
} from "lucide-react";
import {
  copyToClipboard,
  exportToMarkdown,
  exportToPDF,
} from "@/lib/chat-export";
// Available modes
const AGENT_MODES = [
  { id: "plan", label: "Plan & Execute" },
  { id: "fast", label: "Fast (ReAct)" },
];

import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { ClientAccountService } from "@/lib/client-account-service";
import { UIAccount } from "@/lib/types";

// Available models
const AVAILABLE_MODELS = [
  {
    id: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    label: "Claude 4.5 Sonnet",
    provider: "amazon",
  },
  {
    id: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    label: "Claude 4.5 Haiku",
    provider: "amazon",
  },
  {
    id: "global.anthropic.claude-opus-4-5-20251101-v1:0",
    label: "Claude 4.5 Opus",
    provider: "amazon",
  },
  {
    id: "global.anthropic.claude-sonnet-4-6",
    label: "Claude 4.6 Sonnet",
    provider: "amazon",
  },
  {
    id: "global.anthropic.claude-opus-4-6-v1",
    label: "Claude 4.6 Opus",
    provider: "amazon",
  },
  {
    id: "global.amazon.nova-2-lite-v1:0",
    label: "Nova 2 Lite",
    provider: "amazon",
  },
];

// Phase types matching backend
type AgentPhase =
  | "planning"
  | "execution"
  | "reflection"
  | "revision"
  | "final"
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
};

interface ChatInterfaceProps {
  threadId: string;
}

interface MessageRowProps {
  message: any;
  renderPhaseBlock: (phase: AgentPhase, content: string, key: string, isLastMessage?: boolean) => React.ReactNode;
  renderToolInvocation: (part: any, messageId: string, index: number) => React.ReactNode;
}

const MessageRow = React.memo(function MessageRow({ message, renderPhaseBlock, renderToolInvocation }: MessageRowProps) {
  const isUser = message.role === "user";
  return (
    <div
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
        {/* Render parts */}
        {message.parts &&
          message.parts.map((part: any, index: number) => {
            // Text part
            if (part.type === "text") {
              const text = part.text || "";
              if (!text.trim()) return null;
              return (
                <div key={`${message.id}-part-${index}`}>
                  <MarkdownContent content={text} />
                </div>
              );
            }

            // Reasoning part (contains phase markers)
            if (part.type === "reasoning") {
              const { phase, cleanContent } = parsePhaseFromContent(
                part.text || "",
              );
              return renderPhaseBlock(
                phase,
                cleanContent,
                `${message.id}-part-${index}`,
              );
            }

            // Tool invocation
            if (part.type === "tool-invocation" || part.toolCallId) {
              return renderToolInvocation(part, message.id, index);
            }

            return null;
          })}

        {/* Fallback for simple content */}
        {!message.parts && message.content && (
          <MarkdownContent
            content={
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content)
            }
          />
        )}
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

export function ChatInterface({
  threadId: initialThreadId,
}: ChatInterfaceProps) {
  const [threadId] = useState(initialThreadId);

  // Configuration state (before conversation starts)
  const [autoApprove, setAutoApprove] = useState(true);
  const [selectedModel, setSelectedModel] = useState(AVAILABLE_MODELS[0].id);
  const [agentMode, setAgentMode] = useState("plan");
  const [hasStarted, setHasStarted] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [wasStopped, setWasStopped] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const streamTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastMessageContentRef = useRef<string>("");
  const planStepCacheRef = useRef(new Map<string, string[]>());
  // Ref mirror of isStreaming — lets us read the current value inside effects/callbacks
  // without adding it to dependency arrays (avoids extra re-renders).
  const isStreamingRef = useRef(isStreaming);
  // rAF handle for debounced auto-scroll — cancelled if a new message arrives before the frame fires.
  const scrollRafRef = useRef<number | null>(null);

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

  // MCP server selection state
  const [mcpServers, setMcpServers] = useState<
    Array<{ id: string; name: string; description: string; enabled: boolean }>
  >([]);
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>(
    [],
  );
  const [mcpServersLoading, setMcpServersLoading] = useState(false);
  const [mcpDropdownOpen, setMcpDropdownOpen] = useState(false);
  const mcpDropdownRef = useRef<HTMLDivElement>(null);

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
          // Auto-select any pre-enabled servers
          const preEnabled = (data.servers || [])
            .filter((s: any) => s.enabled)
            .map((s: any) => s.id);
          if (preEnabled.length > 0) setSelectedMcpServerIds(preEnabled);
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

  const { messages, sendMessage, isLoading, setMessages, addToolResult, stop } =
    useChat({
      api: "/api/chat",
      maxSteps: 10,
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
      },
      onResponse: (response: Response) => {
        console.log("[ChatInterface] Received response headers:", response);
      },
      onFinish: (message: any, options: any) => {
        console.log("[ChatInterface] Chat finished. Final message:", message);
        console.log("[ChatInterface] Usage/Options:", options);
      },
      onError: (error) => {
        console.error("[ChatInterface] Chat error:", error);
      },
    }) as any;

  // Fetch conversation history when component mounts (for existing threads)
  useEffect(() => {
    async function fetchHistory() {
      // Only fetch if this looks like an existing thread (not a new timestamp-based ID)
      // We attempt to fetch history for all threads; if none exists, API returns empty array
      console.log(
        "[ChatInterface] Attempting to fetch history for thread:",
        threadId,
      );
      setIsLoadingHistory(true);

      try {
        const res = await fetch(`/api/threads/${threadId}/history`);
        if (res.ok) {
          const data = await res.json();
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
        } else {
          console.warn("[ChatInterface] Failed to fetch history:", res.status);
        }
      } catch (error) {
        console.error("[ChatInterface] Error fetching history:", error);
      } finally {
        setIsLoadingHistory(false);
      }
    }

    fetchHistory();
  }, [threadId, setMessages]);

  // Keep isStreamingRef in sync so callbacks can read the current value without a dependency.
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  });

  useEffect(() => {
    console.log("[ChatInterface] Messages State Updated:", messages);
    if (messages.length > 0) {
      setHasStarted(true);

      // Track streaming state based on message content changes
      const lastMessage = messages[messages.length - 1];
      // Use a lightweight fingerprint instead of JSON.stringify to avoid blocking the main thread
      // when the last message contains large tool outputs (100KB+)
      const parts = lastMessage.parts || [];
      const lastPart = parts[parts.length - 1];
      const currentContent = `${lastMessage.id}-${parts.length}-${lastPart?.type ?? ""}-${String(lastPart?.text?.length ?? lastPart?.toolCallId ?? "")}`;

      // If content changed, we're actively streaming
      if (currentContent !== lastMessageContentRef.current) {
        lastMessageContentRef.current = currentContent;

        // Only call setIsStreaming(true) when not already streaming — avoids a redundant
        // state update (and the consequent re-render) on every streaming chunk.
        if (!isStreamingRef.current) setIsStreaming(true);

        // Clear any existing timeout
        if (streamTimeoutRef.current) {
          clearTimeout(streamTimeoutRef.current);
        }

        // Set streaming to false after 2 seconds of no updates
        streamTimeoutRef.current = setTimeout(() => {
          console.log(
            "[ChatInterface] Stream appears to have ended (no updates for 2s)",
          );
          setIsStreaming(false);
        }, 2000);
      }
    }
  }, [messages]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (streamTimeoutRef.current) {
        clearTimeout(streamTimeoutRef.current);
      }
    };
  }, []);

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
    if (!inputValue.trim() || isEnhancing || isLoading || isStreaming) return;

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
    if (!inputValue.trim() || isLoading) return;

    const value = inputValue;
    setInputValue("");
    setHasStarted(true);
    setWasStopped(false);
    setUserHasScrolledUp(false); // Reset scroll state on new message

    await sendMessage(
      {
        content: value,
        role: "user",
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
        },
      },
    );
  };

  const handleStop = () => {
    console.log(
      "[ChatInterface] Stop button clicked, isLoading:",
      isLoading,
      "isStreaming:",
      isStreaming,
    );
    setWasStopped(true);
    setIsStreaming(false);
    if (streamTimeoutRef.current) {
      clearTimeout(streamTimeoutRef.current);
      streamTimeoutRef.current = null;
    }
    stop();
    console.log(
      "[ChatInterface] Stop called, wasStopped set to true, isStreaming set to false",
    );
  };

  // Handle tool approval - makes explicit API call to resume LangGraph execution
  const handleToolApproval = async (toolCallId: string, approved: boolean) => {
    console.log(
      `[ChatInterface] Tool ${approved ? "approved" : "rejected"}: ${toolCallId}`,
    );

    // First, update local state via addToolResult (for UI feedback)
    const result = approved ? "Approved" : "Cancelled by user";
    addToolResult({ toolCallId, result });

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
        },
      },
    );
  };

  // Render a phase block
  const renderPhaseBlock = useCallback((
    phase: AgentPhase,
    content: string,
    key: string,
    isLastMessage: boolean = false,
  ) => {
    const config = phaseConfig[phase];
    const Icon = config.icon;

    // Parse plan steps from content - handle multiple formats
    // Use cache to avoid re-parsing identical content on every render
    let planSteps: string[] = [];

    if (phase === "planning") {
      const cacheKey = content;
      const cached = planStepCacheRef.current.get(cacheKey);
      if (cached) {
        planSteps = cached;
      } else {
        // Try to parse as JSON array first (e.g., ["Step 1: ...", "Step 2: ..."])
        const jsonMatch = content.match(/\[[\s\S]*\]/);
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
          planSteps = content.split("\n").filter((line) => {
            const trimmed = line.trim();
            return (
              /^(\d+[\.\):]|\-|\*|•|Step\s*\d+)/i.test(trimmed) &&
              trimmed.length > 5
            );
          });
        }

        // Also check for markdown bold headers like "**Plan Created:**"
        if (planSteps.length === 0 && content.includes("**")) {
          // Extract content after headers
          const lines = content
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
          <Plan defaultOpen={true} isStreaming={isLoading && isLastMessage}>
            <PlanHeader title="Execution Plan" />
            <PlanContent>
              {planSteps.map((step, i) => (
                <PlanStep
                  key={i}
                  number={i + 1}
                  status={i === 0 && isLoading ? "active" : "pending"}
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
            isStreaming={isLoading && isLastMessage}
          >
            <ReasoningTrigger label="Agent Reflection" />
            <ReasoningContent>{content}</ReasoningContent>
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
          {isLoading && isLastMessage && (
            <Loader2 className="w-3 h-3 animate-spin ml-auto" />
          )}
        </div>
        <div className="p-3 text-muted-foreground/90 leading-relaxed text-sm overflow-hidden min-w-0 break-words [overflow-wrap:anywhere]">
          <MarkdownContent content={content} />
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
    const toolName = part.toolName || "tool";
    const args = part.args || part.input;
    const result = part.result || part.output;
    const state = part.state;

    const isCall = state === "call" || !result;
    // Show approval UI only when: not auto-approve AND tool is in "call" state without result
    const isPending = !autoApprove && isCall && !result && !isLoading;

    // Determine tool state for new component
    const toolState =
      result && result !== "Approved" && result !== "Cancelled by user"
        ? "complete"
        : isLoading && isCall && !result
          ? "running"
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
        defaultOpen={toolState === "running" || isPending}
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
                  onClick={() => handleToolApproval(part.toolCallId, false)}
                >
                  <X className="w-3 h-3 mr-1" />
                  Reject
                </ConfirmationAction>
                <ConfirmationAction
                  variant="default"
                  onClick={() => handleToolApproval(part.toolCallId, true)}
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

          {/* Output with loading state — truncated to TOOL_OUTPUT_TRUNCATE_BYTES if large */}
          <ToolOutputWithTruncation
            output={
              result !== "Approved" && result !== "Cancelled by user"
                ? result
                : undefined
            }
            isLoading={isLoading && isCall && !result}
            label="Output"
          />
        </ToolContent>
      </Tool>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoApprove, isLoading, handleToolApproval]);

  // Sample prompts
  const samplePrompts = [
    "Vital check of my ec2 instances",
    "Review the Cost of the AWS Account for the last 3 months and share the key movers and optimization scope",
    "Review my AWS Lambda functions",
  ];

  return (
    <div className="flex flex-col h-full max-w-[95%] mx-auto w-full border rounded-xl overflow-hidden shadow-lg bg-background">
      {/* Header */}
      <div className="p-4 border-b bg-gradient-to-r from-primary/10 to-primary/5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10 border shadow-sm">
            <AvatarFallback className="bg-gradient-to-br from-primary to-primary/80 text-primary-foreground font-bold">
              <Bot className="h-5 w-5" />
            </AvatarFallback>
          </Avatar>
          <div>
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
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* AWS Account Multi-Select with Search */}
          <div className="relative" ref={accountDropdownRef}>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1 px-3 min-w-[180px] justify-between"
              onClick={() => setAccountDropdownOpen(!accountDropdownOpen)}
            >
              <div className="flex items-center gap-1.5">
                <Cloud
                  className={cn(
                    "w-3.5 h-3.5",
                    selectedAccountIds.length > 0
                      ? "text-amber-500"
                      : "text-muted-foreground",
                  )}
                />
                <span className="truncate max-w-[140px]">
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
              <div className="absolute right-0 top-full mt-1 z-50 w-[320px] rounded-lg border bg-popover shadow-lg">
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
                <div className="p-2 border-t flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">
                    {selectedAccountIds.length} selected
                  </span>
                  <div className="flex gap-2">
                    {selectedAccountIds.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => setSelectedAccountIds([])}
                      >
                        Clear
                      </Button>
                    )}
                    <Button
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

          {/* Skills Selector Dropdown */}
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4" onScrollCapture={handleScroll}>
        <div id="chat-messages-container" className="space-y-4">
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

          {/* Render messages */}
          {messages.map((message: any) => (
            <MessageRow
              key={message.id}
              message={message}
              renderPhaseBlock={renderPhaseBlock}
              renderToolInvocation={renderToolInvocation}
            />
          ))}

          {/* Loading indicator */}
          {(isLoading || isStreaming) && (
            <div className="flex gap-3 justify-start">
              <Avatar className="h-8 w-8 flex-shrink-0 border shadow-sm">
                <AvatarFallback className="bg-gradient-to-br from-primary/80 to-primary text-primary-foreground text-xs">
                  <Bot className="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
              <div className="bg-muted/50 border rounded-lg p-3 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Processing...</span>
              </div>
            </div>
          )}

          {/* Stopped indicator */}
          {wasStopped && !isLoading && !isStreaming && (
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

          <div ref={scrollRef} />
        </div>
      </ScrollArea>

      {/* Input Area - Unified Card Design */}
      <div className="p-2 bg-background border-t">
        <form
          onSubmit={handleFormSubmit}
          className="border rounded-xl shadow-sm bg-card overflow-hidden focus-within:ring-1 focus-within:ring-ring transition-all"
        >
          {/* Header: Model Selection & AWS Account & Settings */}
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/20">
            <div className="flex items-center gap-2">
              {/* Model Selector */}
              <Select value={selectedModel} onValueChange={setSelectedModel}>
                <SelectTrigger className="h-7 text-xs border-transparent bg-transparent hover:bg-muted/50 focus:ring-0 gap-1 px-2 w-auto min-w-[180px]">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-primary" />
                    <SelectValue placeholder="Select Model" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {AVAILABLE_MODELS.map((model) => (
                    <SelectItem
                      key={model.id}
                      value={model.id}
                      className="text-xs"
                    >
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Skills Selector */}
              <Select
                value={selectedSkill || "none"}
                onValueChange={(value) =>
                  setSelectedSkill(value === "none" ? null : value)
                }
                disabled={hasStarted}
              >
                <SelectTrigger className="h-7 text-xs border-transparent bg-transparent hover:bg-muted/50 focus:ring-0 gap-1 px-2 w-auto min-w-[180px]">
                  <div className="flex items-center gap-1.5">
                    <Briefcase
                      className={cn(
                        "w-3 h-3",
                        selectedSkill
                          ? "text-purple-500"
                          : "text-muted-foreground",
                      )}
                    />
                    <span className="truncate max-w-[140px]">
                      {selectedSkill
                        ? availableSkills.find((s) => s.id === selectedSkill)
                            ?.name
                        : "Select Agent Skill"}
                    </span>
                  </div>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    <div className="flex flex-col">
                      <span className="font-medium">No Skill</span>
                      <span className="text-xs text-muted-foreground">
                        No specific skill
                      </span>
                    </div>
                  </SelectItem>
                  {availableSkills.map((skill) => (
                    <SelectItem key={skill.id} value={skill.id}>
                      <div className="flex flex-col">
                        <span className="font-medium">{skill.name}</span>
                        <span className="text-xs text-muted-foreground truncate max-w-[250px]">
                          {skill.description}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

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
                      <div className="max-h-[300px] overflow-y-auto p-1">
                        {mcpServers.map((server) => (
                          <label
                            key={server.id}
                            className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted cursor-pointer text-sm transition-colors"
                          >
                            <Checkbox
                              checked={selectedMcpServerIds.includes(server.id)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSelectedMcpServerIds([
                                    ...selectedMcpServerIds,
                                    server.id,
                                  ]);
                                } else {
                                  setSelectedMcpServerIds(
                                    selectedMcpServerIds.filter(
                                      (id) => id !== server.id,
                                    ),
                                  );
                                }
                              }}
                              className="h-4 w-4"
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
                          </label>
                        ))}
                      </div>
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
                            onClick={() => setMcpDropdownOpen(false)}
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
                    // Optional: Toast notification could go here
                  }
                }}
                title="Copy chat to clipboard"
                disabled={messages.length === 0}
              >
                <Copy className="w-3.5 h-3.5" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                onClick={async () => {
                  await exportToMarkdown(messages, threadId);
                }}
                title="Export to Markdown"
                disabled={messages.length === 0}
              >
                <Download className="w-3.5 h-3.5" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                onClick={async () => {
                  await exportToPDF(messages, threadId);
                }}
                title="Export to PDF"
                disabled={messages.length === 0}
              >
                <FileText className="w-3.5 h-3.5" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                onClick={handleClear}
                title="Clear conversation"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>

              <div className="w-px h-4 bg-border mx-1" />

              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-full text-muted-foreground"
                type="button"
                onClick={() => (window.location.href = "/agent/mcp-settings")}
                title="MCP Server Settings"
              >
                <Settings className="w-3.5 h-3.5" />
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
              disabled={isLoading}
              className="min-h-[80px] max-h-[500px] w-full border-0 focus-visible:ring-0 resize-y overflow-y-auto p-3 text-sm bg-transparent"
            />
          </div>

          {/* Footer: Controls & Send */}
          <div className="flex items-center justify-between px-3 py-2 border-t bg-muted/10">
            <div className="flex items-center gap-4">
              <div className="flex items-center space-x-2">
                <Select value={agentMode} onValueChange={setAgentMode}>
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
                  className="data-[state=checked]:bg-green-600 data-[state=checked]:border-green-600 h-4 w-4"
                />
                <Label
                  htmlFor="auto-approve-chat"
                  className="text-xs font-medium cursor-pointer text-muted-foreground select-none"
                >
                  Auto-approve tools
                </Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="show-tools"
                  defaultChecked={true}
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
                  !inputValue.trim() || isLoading || isStreaming || isEnhancing
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
                type={isLoading || isStreaming ? "button" : "submit"}
                onClick={isLoading || isStreaming ? handleStop : undefined}
                disabled={!(isLoading || isStreaming) && !inputValue.trim()}
                size="icon"
                className={cn(
                  "h-8 w-8 rounded-full shrink-0 transition-all",
                  isLoading || isStreaming
                    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    : "bg-primary hover:bg-primary/90",
                )}
              >
                {isLoading || isStreaming ? (
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
  );
}
