'use client';

import { useChat } from '@ai-sdk/react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { 
  Bot, User, Trash2, Loader2, Terminal, Send, 
  Briefcase, Cpu, Check, X, Brain, RefreshCw, 
  Flag, ListChecks, Sparkles, Settings, Zap
} from 'lucide-react';
// Available modes
const AGENT_MODES = [
  { id: 'plan', label: 'Plan & Execute' },
  { id: 'fast', label: 'Fast (ReAct)' },
];

import { useEffect, useRef, useState } from 'react';
import { Task, TaskTrigger, TaskContent, TaskItem } from '@/components/ai-elements/task';
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

// Available models
const AVAILABLE_MODELS = [
  { id: 'moonshot.kimi-k2-thinking', label: 'Kimi K2 Thinking', provider: 'moonshot' },
  { id: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude 4.5 Sonnet (Global)', provider: 'amazon' },
  { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude 4.5 Haiku (US)', provider: 'amazon' },
  { id: 'global.amazon.nova-2-lite-v1:0', label: 'Nova 2 Lite (Global)', provider: 'amazon' },
  { id: 'us.deepseek.r1-v1:0', label: 'DeepSeek R1 (US)', provider: 'amazon' },
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

  const { 
    messages, 
    sendMessage,
    isLoading, 
    setMessages,
    addToolResult,
  } = useChat({
    api: '/api/chat',
    maxSteps: 10,
    body: {
        threadId,
        autoApprove,
        model: selectedModel,
        mode: agentMode,
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

  // Reset state when threadId changes results in a new instance (handled by parent key),
  // but if we reuse component, we might need effect.
  // Actually, standard pattern is to use key={threadId} on the component in parent.
  // So we don't need complex reset logic here if parent handles it.
  
  useEffect(() => {
    // If we kept the same component instance but prop changed, we should probably reset or fetch history.
    // For now, parent `key` prop approach is safest.
  }, [initialThreadId]);

  useEffect(() => {
    console.log('[ChatInterface] Messages State Updated:', messages);
    if (messages.length > 0) {
      setHasStarted(true);
    }
  }, [messages]);

  const [inputValue, setInputValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages]);

  const handleClear = () => {
    setMessages([]);
    setHasStarted(false);
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
    
    await sendMessage({
      content: value,
      role: 'user'
    }, {
      body: {
        threadId,
        autoApprove,
        model: selectedModel,
        mode: agentMode,
      }
    });
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
      }
    });
  };

  // Render a phase block
  const renderPhaseBlock = (phase: AgentPhase, content: string, key: string) => {
    const config = phaseConfig[phase];
    const Icon = config.icon;

    // Try to parse plan steps if it's a planning phase with numbered list
    const planSteps = phase === 'planning' ? 
      content.split('\n').filter(line => /^\d+\./.test(line.trim())) : [];

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
          "px-3 py-1.5 font-semibold flex items-center gap-2 border-b",
          `${config.bgColor.replace('/5', '/10')}`,
          config.textColor
        )}>
          <Icon className="w-3.5 h-3.5" />
          {config.label}
        </div>
        
        {planSteps.length > 0 ? (
          <div className="p-3">
            <Task defaultOpen={true}>
              <TaskTrigger title="Execution Plan" status="in_progress" />
              <TaskContent>
                {planSteps.map((step, i) => (
                  <TaskItem key={i} status="pending">
                    {step.replace(/^\d+\.\s*/, '')}
                  </TaskItem>
                ))}
              </TaskContent>
            </Task>
          </div>
        ) : (
          <div className="p-3 whitespace-pre-wrap text-muted-foreground/90 leading-relaxed font-mono">
            {content}
          </div>
        )}
      </div>
    );
  };

  // Render tool invocation
  const renderToolInvocation = (part: any, messageId: string, index: number) => {
    const toolName = part.toolName || 'tool';
    const args = part.args || part.input;
    const result = part.result || part.output;
    const state = part.state;
    
    const isCall = state === 'call' || !result;
    // Show approval UI only when: not auto-approve AND tool is in "call" state without result
    const isPending = !autoApprove && isCall && !result && !isLoading;

    // Determine approval state for Confirmation component
    const approvalState = result === 'Approved' ? 'approved' : 
                          result === 'Cancelled by user' ? 'rejected' : 
                          isPending ? 'pending' : undefined;

    return (
      <div
        key={part.toolCallId || `${messageId}-tool-${index}`}
        className="w-full border rounded-lg overflow-hidden bg-muted/5 text-sm mt-2 shadow-sm"
      >
        {/* Tool Header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-muted/10 border-b">
          <Terminal className="w-4 h-4 text-primary/60" />
          <span className="font-semibold text-xs tracking-tight">
            {toolName.toUpperCase()}
          </span>
          {autoApprove && (
            <span className="ml-1 text-[10px] text-success bg-success/10 px-1.5 py-0.5 rounded-full font-medium">
              AUTO
            </span>
          )}
          {isLoading && isCall && !result && (
            <Loader2 className="w-3 h-3 animate-spin ml-auto text-muted-foreground" />
          )}
          {result && result !== 'Approved' && result !== 'Cancelled by user' && (
            <Check className="w-3 h-3 text-success ml-auto" />
          )}
        </div>

        {/* Command / Input */}
        <div className="px-3 py-2 font-mono text-[11px] bg-black/5 dark:bg-white/5 border-b border-dashed border-muted/20">
          <span className="text-primary/40 select-none">$ </span>
          <span>{typeof args === 'string' ? args : JSON.stringify(args)}</span>
        </div>

        {/* Approval UI using Confirmation component - only when autoApprove is OFF */}
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

        {/* Result */}
        {result && result !== 'Approved' && result !== 'Cancelled by user' && (
          <div className="px-3 py-2 border-t font-mono text-[11px] whitespace-pre-wrap break-all max-h-60 overflow-y-auto bg-muted/5">
            {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
          </div>
        )}
      </div>
    );
  };



  // Sample prompts
  const samplePrompts = [
    "List all files in the current directory",
    "Search the web for LangGraph best practices",
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
              Nucleus Reflection Agent
              <Sparkles className="w-4 h-4 text-warning" />
            </h2>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              Plan → Execute → Reflect → Revise
              {autoApprove && <span className="text-success ml-1">(Auto-Approve ON)</span>}
            </p>
          </div>
        </div>
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



      {/* Messages */}
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {/* Initial prompt suggestions when no messages */}
          {messages.length === 0 && (
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
                        <div key={`${message.id}-part-${index}`} className="whitespace-pre-wrap">
                          {text}
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
                    <div className="whitespace-pre-wrap">{message.content}</div>
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
          {isLoading && (
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

          <div ref={scrollRef} />
        </div>
      </ScrollArea>

      {/* Input Area - Unified Card Design */}
      <div className="p-4 bg-background border-t">
        <form onSubmit={handleFormSubmit} className="border rounded-xl shadow-sm bg-card overflow-hidden focus-within:ring-1 focus-within:ring-ring transition-all">
          
          {/* Header: Model Selection & Settings */}
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/20">
            <div className="flex items-center gap-2">
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
                • {13} tools available
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
                type="submit" 
                disabled={isLoading || !inputValue.trim()}
                size="icon"
                className="h-8 w-8 rounded-full bg-primary hover:bg-primary/90 shrink-0 transition-all"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
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
