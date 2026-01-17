'use client';

import { useChat } from '@ai-sdk/react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { MarkdownContent } from '@/components/ui/markdown-content';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { 
  Bot, User, Trash2, Loader2, Terminal, Send, 
  Briefcase, Cpu, Check, X, Brain, RefreshCw, 
  Flag, ListChecks, Sparkles, Settings, Zap, Cloud
} from 'lucide-react';
// Available modes
const AGENT_MODES = [
  { id: 'plan', label: 'Plan & Execute' },
  { id: 'fast', label: 'Fast (ReAct)' },
];

import { useEffect, useRef, useState } from 'react';
import { Plan, PlanHeader, PlanContent, PlanStep } from '@/components/ai-elements/plan';
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import { Reasoning, ReasoningTrigger, ReasoningContent } from '@/components/ai-elements/reasoning';
import { 
  Confirmation, 
  ConfirmationRequest, 
  ConfirmationAccepted, 
  ConfirmationRejected, 
  ConfirmationActions, 
  ConfirmationAction 
} from '@/components/ai-elements/confirmation';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ClientAccountService } from '@/lib/client-account-service';
import { UIAccount } from '@/lib/types';

// Available models
const AVAILABLE_MODELS = [
  { id: 'global.amazon.nova-2-lite-v1:0', label: 'Nova 2 Lite (Global)', provider: 'amazon' },
  { id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude 4.5 Haiku (Global)', provider: 'amazon' },
  { id: 'global.anthropic.claude-opus-4-5-20251101-v1:0', label: 'Claude 4.5 Opus (Global)', provider: 'amazon' },
  { id: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude 4.5 Sonnet (Global)', provider: 'amazon' },
];

// Phase types matching backend
type AgentPhase = 'planning' | 'execution' | 'reflection' | 'revision' | 'final' | 'text';

// Parse phase from content
function parsePhaseFromContent(content: string): { phase: AgentPhase; cleanContent: string } {
  if (content.startsWith("PLANNING_PHASE_START\n")) {
    return { phase: 'planning', cleanContent: content.replace("PLANNING_PHASE_START\n", "") };
  } else if (content.startsWith("EXECUTION_PHASE_START\n")) {
    return { phase: 'execution', cleanContent: content.replace("EXECUTION_PHASE_START\n", "") };
  } else if (content.startsWith("REFLECTION_PHASE_START\n")) {
    return { phase: 'reflection', cleanContent: content.replace("REFLECTION_PHASE_START\n", "") };
  } else if (content.startsWith("REVISION_PHASE_START\n")) {
    return { phase: 'revision', cleanContent: content.replace("REVISION_PHASE_START\n", "") };
  } else if (content.startsWith("FINAL_PHASE_START\n")) {
    return { phase: 'final', cleanContent: content.replace("FINAL_PHASE_START\n", "") };
  }
  return { phase: 'text', cleanContent: content };
}

// Phase configuration
const phaseConfig: Record<AgentPhase, { 
  icon: React.ElementType; 
  label: string; 
  borderColor: string; 
  bgColor: string; 
  textColor: string;
}> = {
  planning: { 
    icon: ListChecks, 
    label: 'PLANNING', 
    borderColor: 'border-blue-500', 
    bgColor: 'bg-info/100/5', 
    textColor: 'text-info' 
  },
  execution: { 
    icon: Cpu, 
    label: 'EXECUTION', 
    borderColor: 'border-amber-500', 
    bgColor: 'bg-amber-500/5', 
    textColor: 'text-amber-600' 
  },
  reflection: { 
    icon: Brain, 
    label: 'REFLECTION', 
    borderColor: 'border-purple-500', 
    bgColor: 'bg-purple-500/5', 
    textColor: 'text-purple-600' 
  },
  revision: { 
    icon: RefreshCw, 
    label: 'REVISION', 
    borderColor: 'border-cyan-500', 
    bgColor: 'bg-cyan-500/5', 
    textColor: 'text-cyan-600' 
  },
  final: { 
    icon: Flag, 
    label: 'COMPLETE', 
    borderColor: 'border-green-500', 
    bgColor: 'bg-success/100/5', 
    textColor: 'text-success' 
  },
  text: { 
    icon: Bot, 
    label: 'RESPONSE', 
    borderColor: 'border-muted', 
    bgColor: 'bg-muted/10', 
    textColor: 'text-muted-foreground' 
  },
};

interface ChatInterfaceProps {
  threadId: string;
}

export function ChatInterface({ threadId: initialThreadId }: ChatInterfaceProps) {
  const [threadId] = useState(initialThreadId);
  
  // Configuration state (before conversation starts)
  const [autoApprove, setAutoApprove] = useState(true);
  const [selectedModel, setSelectedModel] = useState(AVAILABLE_MODELS[0].id);
  const [agentMode, setAgentMode] = useState('plan');
  const [hasStarted, setHasStarted] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [wasStopped, setWasStopped] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastMessageContentRef = useRef<string>('');
  
  // Scroll control state - track if user has manually scrolled up
  const [userHasScrolledUp, setUserHasScrolledUp] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  
  // AWS Account selection state
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [accountsLoading, setAccountsLoading] = useState(true);

  // Fetch accounts on mount
  useEffect(() => {
    async function fetchAccounts() {
      try {
        setAccountsLoading(true);
        const { accounts: fetchedAccounts } = await ClientAccountService.getAccounts({ 
          statusFilter: 'active',
          connectionFilter: 'connected'
        });
        setAccounts(fetchedAccounts);
        console.log('[ChatInterface] Loaded accounts:', fetchedAccounts.length);
      } catch (error) {
        console.error('[ChatInterface] Failed to load accounts:', error);
      } finally {
        setAccountsLoading(false);
      }
    }
    fetchAccounts();
  }, []);

  // Get selected account details for API
  const selectedAccount = accounts.find(a => a.accountId === selectedAccountId);

  const { 
    messages, 
    sendMessage,
    isLoading, 
    setMessages,
    addToolResult,
    stop,
  } = useChat({
    api: '/api/chat',
    maxSteps: 10,
    body: {
        threadId,
        autoApprove,
        model: selectedModel,
        mode: agentMode,
        accountId: selectedAccountId || undefined,
        accountName: selectedAccount?.name || undefined,
    },
    onResponse: (response: Response) => {
        console.log('[ChatInterface] Received response headers:', response);
    },
    onFinish: (message: any, options: any) => {
        console.log('[ChatInterface] Chat finished. Final message:', message);
        console.log('[ChatInterface] Usage/Options:', options);
    },
    onError: (error) => {
      console.error('[ChatInterface] Chat error:', error);
    },
  }) as any;

  // Fetch conversation history when component mounts (for existing threads)
  useEffect(() => {
    async function fetchHistory() {
      // Only fetch if this looks like an existing thread (not a new timestamp-based ID)
      // We attempt to fetch history for all threads; if none exists, API returns empty array
      console.log('[ChatInterface] Attempting to fetch history for thread:', threadId);
      setIsLoadingHistory(true);
      
      try {
        const res = await fetch(`/api/threads/${threadId}/history`);
        if (res.ok) {
          const data = await res.json();
          if (data.messages && data.messages.length > 0) {
            console.log('[ChatInterface] Loaded', data.messages.length, 'historical messages');
            setMessages(data.messages);
            setHasStarted(true);
          } else {
            console.log('[ChatInterface] No history found for thread');
          }
        } else {
          console.warn('[ChatInterface] Failed to fetch history:', res.status);
        }
      } catch (error) {
        console.error('[ChatInterface] Error fetching history:', error);
      } finally {
        setIsLoadingHistory(false);
      }
    }
    
    fetchHistory();
  }, [threadId, setMessages]);

  useEffect(() => {
    console.log('[ChatInterface] Messages State Updated:', messages);
    if (messages.length > 0) {
      setHasStarted(true);
      
      // Track streaming state based on message content changes
      const lastMessage = messages[messages.length - 1];
      const currentContent = JSON.stringify(lastMessage);
      
      // If content changed, we're actively streaming
      if (currentContent !== lastMessageContentRef.current) {
        lastMessageContentRef.current = currentContent;
        setIsStreaming(true);
        
        // Clear any existing timeout
        if (streamTimeoutRef.current) {
          clearTimeout(streamTimeoutRef.current);
        }
        
        // Set streaming to false after 2 seconds of no updates
        streamTimeoutRef.current = setTimeout(() => {
          console.log('[ChatInterface] Stream appears to have ended (no updates for 2s)');
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

  const [inputValue, setInputValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Handle scroll events to detect user scroll intent
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const isAtBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 50;
    
    if (isAtBottom) {
      setUserHasScrolledUp(false);
    } else {
      // User has scrolled up - don't auto-scroll
      setUserHasScrolledUp(true);
    }
  };

  // Auto-scroll to bottom only when user hasn't scrolled up
  useEffect(() => {
    if (scrollRef.current && !userHasScrolledUp) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleFormSubmit(e as any);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading) return;

    const value = inputValue;
    setInputValue('');
    setHasStarted(true);
    setWasStopped(false);
    setUserHasScrolledUp(false); // Reset scroll state on new message
    
    await sendMessage({
      content: value,
      role: 'user'
    }, {
      body: {
        threadId,
        autoApprove,
        model: selectedModel,
        mode: agentMode,
        accountId: (selectedAccountId && selectedAccountId !== 'no_account') ? selectedAccountId : undefined,
        accountName: selectedAccount?.name || undefined,
      }
    });
  };

  const handleStop = () => {
    console.log('[ChatInterface] Stop button clicked, isLoading:', isLoading, 'isStreaming:', isStreaming);
    setWasStopped(true);
    setIsStreaming(false);
    if (streamTimeoutRef.current) {
      clearTimeout(streamTimeoutRef.current);
      streamTimeoutRef.current = null;
    }
    stop();
    console.log('[ChatInterface] Stop called, wasStopped set to true, isStreaming set to false');
  };

  // Handle tool approval - makes explicit API call to resume LangGraph execution
  const handleToolApproval = async (toolCallId: string, approved: boolean) => {
    console.log(`[ChatInterface] Tool ${approved ? 'approved' : 'rejected'}: ${toolCallId}`);
    
    // First, update local state via addToolResult (for UI feedback)
    const result = approved ? 'Approved' : 'Cancelled by user';
    addToolResult({ toolCallId, result });
    
    // Then, make explicit API call to resume the graph
    // We send the tool result as a message with role: 'tool'
    await sendMessage({
      role: 'tool' as any,
      content: result,
      toolCallId: toolCallId,
    } as any, {
      body: {
        threadId,
        autoApprove,
        model: selectedModel,
        mode: agentMode,
        accountId: (selectedAccountId && selectedAccountId !== 'no_account') ? selectedAccountId : undefined,
        accountName: selectedAccount?.name || undefined,
      }
    });
  };

  // Render a phase block
  const renderPhaseBlock = (phase: AgentPhase, content: string, key: string, isLastMessage: boolean = false) => {
    const config = phaseConfig[phase];
    const Icon = config.icon;

    // Parse plan steps from content - handle multiple formats
    let planSteps: string[] = [];
    
    if (phase === 'planning') {
      // Try to parse as JSON array first (e.g., ["Step 1: ...", "Step 2: ..."])
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) {
            planSteps = parsed.map((step: string) => 
              typeof step === 'string' ? step : JSON.stringify(step)
            );
          }
        } catch (e) {
          // Not valid JSON, continue to line-by-line parsing
        }
      }
      
      // If no JSON array found, try line-by-line parsing
      if (planSteps.length === 0) {
        // Match lines starting with number, bullet, dash, or "Step"
        planSteps = content.split('\n').filter(line => {
          const trimmed = line.trim();
          return /^(\d+[\.\):]|\-|\*|•|Step\s*\d+)/i.test(trimmed) && trimmed.length > 5;
        });
      }
      
      // Also check for markdown bold headers like "**Plan Created:**"
      if (planSteps.length === 0 && content.includes('**')) {
        // Extract content after headers
        const lines = content.split('\n').filter(line => 
          line.trim().length > 0 && !line.includes('**')
        );
        planSteps = lines;
      }
    }

    // Use Plan component for planning phase with steps
    if (phase === 'planning' && planSteps.length > 0) {
      return (
        <div key={key} className="w-full mb-2">
          <div className={cn(
            "flex items-center gap-2 px-3 py-2 text-xs font-semibold border-l-4 rounded-r-md mb-2",
            config.borderColor,
            config.bgColor,
            config.textColor
          )}>
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
                  status={i === 0 && isLoading ? 'active' : 'pending'}
                >
                  {/* Clean up step text - remove numbering prefixes */}
                  {step.replace(/^(\d+[\.\):\s]*|Step\s*\d+[:\.\)]*\s*|\-\s*|\*\s*|•\s*)/i, '').trim()}
                </PlanStep>
              ))}
            </PlanContent>
          </Plan>
        </div>
      );
    }

    // Use Reasoning component for reflection phase
    if (phase === 'reflection') {
      return (
        <div key={key} className="w-full mb-2">
          <div className={cn(
            "flex items-center gap-2 px-3 py-2 text-xs font-semibold border-l-4 rounded-r-md mb-2",
            config.borderColor,
            config.bgColor,
            config.textColor
          )}>
            <Icon className="w-3.5 h-3.5" />
            {config.label}
          </div>
          <Reasoning defaultOpen={true} isStreaming={isLoading && isLastMessage}>
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
          "w-full border-l-4 rounded-r-lg overflow-hidden text-xs mb-2 shadow-sm",
          config.borderColor,
          config.bgColor
        )}
      >
        <div className={cn(
          "px-3 py-2 font-semibold flex items-center gap-2 border-b",
          `${config.bgColor.replace('/5', '/10')}`,
          config.textColor
        )}>
          <Icon className="w-3.5 h-3.5" />
          {config.label}
          {isLoading && isLastMessage && (
            <Loader2 className="w-3 h-3 animate-spin ml-auto" />
          )}
        </div>
        <div className="p-3 text-muted-foreground/90 leading-relaxed text-sm">
          <MarkdownContent content={content} />
        </div>
      </div>
    );
  };

  // Render tool invocation using enhanced Tool component
  const renderToolInvocation = (part: any, messageId: string, index: number) => {
    const toolName = part.toolName || 'tool';
    const args = part.args || part.input;
    const result = part.result || part.output;
    const state = part.state;
    
    const isCall = state === 'call' || !result;
    // Show approval UI only when: not auto-approve AND tool is in "call" state without result
    const isPending = !autoApprove && isCall && !result && !isLoading;

    // Determine tool state for new component
    const toolState = result && result !== 'Approved' && result !== 'Cancelled by user' 
      ? 'complete' 
      : (isLoading && isCall && !result) 
        ? 'running' 
        : 'pending';

    // Determine approval state for Confirmation component
    const approvalState = result === 'Approved' ? 'approved' : 
                          result === 'Cancelled by user' ? 'rejected' : 
                          isPending ? 'pending' : undefined;

    return (
      <Tool
        key={part.toolCallId || `${messageId}-tool-${index}`}
        state={toolState}
        defaultOpen={toolState === 'running' || isPending}
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
            <Confirmation approval={{ id: part.toolCallId, state: 'pending' }} state="pending">
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
          {approvalState === 'approved' && (
            <Confirmation state="approved">
              <ConfirmationAccepted>Tool execution approved</ConfirmationAccepted>
            </Confirmation>
          )}
          {approvalState === 'rejected' && (
            <Confirmation state="rejected">
              <ConfirmationRejected>Tool execution rejected by user</ConfirmationRejected>
            </Confirmation>
          )}

          {/* Output with loading state */}
          <ToolOutput 
            output={result !== 'Approved' && result !== 'Cancelled by user' ? result : undefined}
            isLoading={isLoading && isCall && !result}
            label="Output"
          />
        </ToolContent>
      </Tool>
    );
  };



  // Sample prompts
  const samplePrompts = [
    "List all files in the current directory",
    "Review the Cost of the AWS Account for the last 3 months and share the key movers and optimization scope",
    "Check my AWS Lambda functions"
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-theme(spacing.16))] md:h-[calc(100vh-6rem)] max-w-4xl mx-auto w-full border rounded-xl overflow-hidden shadow-lg bg-background">
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
              DevOps Agent
              <Sparkles className="w-4 h-4 text-warning" />
            </h2>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              Plan → Execute → Reflect → Revise
              {autoApprove && <span className="text-success ml-1">(Auto-Approve ON)</span>}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {/* AWS Account Selector */}
          <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
            <SelectTrigger className="h-8 text-xs bg-background border-input hover:bg-accent hover:text-accent-foreground focus:ring-0 gap-1 px-3 w-auto min-w-[160px]">
              <div className="flex items-center gap-1.5">
                <Cloud className={cn("w-3.5 h-3.5", (selectedAccountId && selectedAccountId !== 'no_account') ? "text-amber-500" : "text-muted-foreground")} />
                <SelectValue placeholder={accountsLoading ? "Loading..." : "Select AWS Account"} />
              </div>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="no_account" className="text-xs text-muted-foreground">
                No Account (AWS Disabled)
              </SelectItem>
              {accounts.map((account) => (
                <SelectItem key={account.accountId} value={account.accountId} className="text-xs">
                  {account.name} ({account.accountId})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button 
            variant="ghost" 
          size="icon" 
          onClick={handleClear} 
          title="Clear conversation"
          className="text-muted-foreground hover:text-foreground"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
        </div>
      </div>



      {/* Messages */}
      <ScrollArea className="flex-1 p-4" onScrollCapture={handleScroll}>
        <div className="space-y-4">
          {/* Loading history indicator */}
          {isLoadingHistory && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-primary mb-4" />
              <p className="text-sm text-muted-foreground">Loading conversation history...</p>
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
                The agent will plan, execute tools, reflect on results, and revise as needed.
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
          {messages.map((message: any) => {
            const isUser = message.role === 'user';
            
            return (
              <div 
                key={message.id} 
                className={cn(
                  "flex gap-3",
                  isUser ? "justify-end" : "justify-start"
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
                <div className={cn(
                  "max-w-[85%] rounded-lg p-3 text-sm",
                  isUser 
                    ? "bg-primary text-primary-foreground ml-auto" 
                    : "bg-muted/50 border"
                )}>
                  {/* Render parts */}
                  {message.parts && message.parts.map((part: any, index: number) => {
                    // Text part
                    if (part.type === 'text') {
                      const text = part.text || "";
                      if (!text.trim()) return null;
                      return (
                        <div key={`${message.id}-part-${index}`}>
                          <MarkdownContent content={text} />
                        </div>
                      );
                    }

                    // Reasoning part (contains phase markers)
                    if (part.type === 'reasoning') {
                      const { phase, cleanContent } = parsePhaseFromContent(part.text || "");
                      return renderPhaseBlock(phase, cleanContent, `${message.id}-part-${index}`);
                    }

                    // Tool invocation
                    if (part.type === 'tool-invocation' || part.toolCallId) {
                      return renderToolInvocation(part, message.id, index);
                    }

                    return null;
                  })}

                  {/* Fallback for simple content */}
                  {!message.parts && message.content && (
                    <MarkdownContent content={typeof message.content === 'string' ? message.content : JSON.stringify(message.content)} />
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
          })}

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
      <div className="p-4 bg-background border-t">
        <form onSubmit={handleFormSubmit} className="border rounded-xl shadow-sm bg-card overflow-hidden focus-within:ring-1 focus-within:ring-ring transition-all">
          
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
                    <SelectItem key={model.id} value={model.id} className="text-xs">
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>



              <span className="text-[10px] text-muted-foreground hidden sm:inline-block">
                • {14} tools available
              </span>
            </div>
            
            <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full text-muted-foreground" type="button">
              <Settings className="w-3.5 h-3.5" />
            </Button>
          </div>

          {/* Body: Textarea */}
          <div className="relative">
            <Textarea
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask the agent to plan, execute, reflect, and revise..."
              disabled={isLoading}
              className="min-h-[80px] w-full border-0 focus-visible:ring-0 resize-none p-3 text-sm bg-transparent"
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
                        <SelectItem key={mode.id} value={mode.id} className="text-xs">
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
                  onCheckedChange={(checked) => setAutoApprove(checked === true)}
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
                type={(isLoading || isStreaming) ? "button" : "submit"}
                onClick={(isLoading || isStreaming) ? handleStop : undefined}
                disabled={!(isLoading || isStreaming) && !inputValue.trim()}
                size="icon"
                className={cn(
                  "h-8 w-8 rounded-full shrink-0 transition-all",
                  (isLoading || isStreaming) 
                    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" 
                    : "bg-primary hover:bg-primary/90"
                )}
              >
                {(isLoading || isStreaming) ? (
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
