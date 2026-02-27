'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { cn } from '@/lib/utils';
import { ThreadSidebar } from './thread-sidebar';
import { TodoPanel } from './todo-panel';
import { SubagentCard } from './subagent-card';
import { ApprovalDialog } from './approval-dialog';
import { McpSkillSelector } from './mcp-skill-selector';
import {
  Send,
  Bot,
  User,
  Loader2,
  Brain,
  ChevronDown,
  ChevronRight,
  Zap,
  Shield,
  Terminal,
  CheckCircle2,
  Circle,
  AlertCircle,
  MemoryStick,
  Cpu,
  ToggleLeft,
  ToggleRight,
  PanelRightOpen,
  PanelRightClose,
  Sparkles,
  Copy,
  Check,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  TodoItem,
  SubagentEvent,
  PendingApproval,
  ApprovalDecision,
  DeepAgentMessage,
  DeepAgentThread,
} from '@/lib/deep-agent/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolCallItem {
  toolCallId: string;
  toolName: string;
  args: any;
  result?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  subagentEvents?: SubagentEvent[];
  toolCalls?: ToolCallItem[];
  approvalRequest?: PendingApproval;
  isStreaming?: boolean;
  phase?: string;
  timestamp: Date;
}

interface ModelOption {
  id: string;
  label: string;
}

const MODELS: ModelOption[] = [
  { id: 'global.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', label: 'Claude 3.5 Sonnet v2' },
  { id: 'anthropic.claude-3-7-sonnet-20250219-v1:0', label: 'Claude 3.7 Sonnet' },
  { id: 'anthropic.claude-3-5-haiku-20241022-v1:0', label: 'Claude 3.5 Haiku' },
  { id: 'amazon.nova-pro-v1:0', label: 'Nova Pro' },
  { id: 'amazon.nova-lite-v1:0', label: 'Nova Lite' },
];

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function DeepAgentChat() {
  // --- State ---
  const [threads, setThreads] = useState<Omit<DeepAgentThread, 'messages'>[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [showTodos, setShowTodos] = useState(true);
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<Array<{ accountId: string; accountName: string }>>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  // --- Scroll to bottom ---
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  // --- Load threads on mount ---
  useEffect(() => {
    fetchThreads();
  }, []);

  async function fetchThreads() {
    try {
      const res = await fetch('/api/deep-agent/threads');
      if (res.ok) {
        const { threads } = await res.json();
        setThreads(threads);
      }
    } catch (e) {
      console.error('Failed to load threads:', e);
    }
  }

  async function loadThread(threadId: string) {
    try {
      const res = await fetch(`/api/deep-agent/threads/${threadId}`);
      if (!res.ok) return;
      const { thread } = await res.json();

      setActiveThreadId(threadId);
      setTodos(thread.todos ?? []);
      // Map persisted messages back to ChatMessage
      setMessages(
        (thread.messages ?? []).map((m: DeepAgentMessage) => ({
          id: m.id,
          role: m.role === 'tool' ? 'assistant' : m.role,
          content: m.content,
          subagentEvents: m.subagentEvents,
          timestamp: new Date(m.timestamp),
        })),
      );
    } catch (e) {
      console.error('Failed to load thread:', e);
    }
  }

  async function createNewThread() {
    const threadId = uuidv4();
    setActiveThreadId(threadId);
    setMessages([]);
    setTodos([]);
    setPendingApproval(null);
    await fetchThreads();
  }

  async function deleteThread(threadId: string) {
    await fetch(`/api/deep-agent/threads/${threadId}`, { method: 'DELETE' });
    if (activeThreadId === threadId) {
      setActiveThreadId(null);
      setMessages([]);
      setTodos([]);
    }
    await fetchThreads();
  }

  // ---------------------------------------------------------------------------
  // SSE stream consumer helper
  // ---------------------------------------------------------------------------

  function consumeStream(
    url: string,
    body: object,
    onEvent: (event: string, data: any) => void,
    onDone: () => void,
    onError: (err: string) => void,
  ) {
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;

    (async () => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          onError(`HTTP ${res.status}`);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const { event, data } = JSON.parse(line.slice(6));
              onEvent(event, data);
            } catch {
              // skip malformed lines
            }
          }
        }
        onDone();
      } catch (err: any) {
        if (err.name !== 'AbortError') onError(err.message);
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------

  async function handleSend() {
    const text = input.trim();
    if (!text || isLoading) return;

    const threadId = activeThreadId || uuidv4();
    if (!activeThreadId) {
      setActiveThreadId(threadId);
    }

    setInput('');
    setIsLoading(true);
    setPendingApproval(null);

    // Append user message to UI
    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);

    // Create streaming assistant message placeholder
    const assistantId = uuidv4();
    const placeholder: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      subagentEvents: [],
      toolCalls: [],
      isStreaming: true,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, placeholder]);

    const config = {
      model: selectedModel,
      autoApprove,
      accounts: selectedAccounts,
      selectedSkills,
      mcpServerIds: selectedMcpServers,
    };

    consumeStream(
      '/api/deep-agent/chat',
      { threadId, message: text, config },
      (event, data) => handleStreamEvent(assistantId, event, data),
      () => {
        setIsLoading(false);
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, isStreaming: false } : m));
        fetchThreads();
      },
      (err) => {
        setIsLoading(false);
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: `Error: ${err}`, isStreaming: false }
            : m,
        ));
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Handle stream events from server
  // ---------------------------------------------------------------------------

  function handleStreamEvent(assistantId: string, event: string, data: any) {
    switch (event) {
      case 'text-delta':
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: m.content + (data.text ?? '') } : m,
        ));
        break;

      case 'tool-call':
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? {
                ...m,
                toolCalls: [...(m.toolCalls ?? []), {
                  toolCallId: data.toolCallId,
                  toolName: data.toolName,
                  args: data.args,
                }],
              }
            : m,
        ));
        break;

      case 'tool-result':
        setMessages(prev => prev.map(m => {
          if (m.id !== assistantId) return m;
          return {
            ...m,
            toolCalls: (m.toolCalls ?? []).map(tc =>
              tc.toolCallId === data.toolCallId ? { ...tc, result: data.result } : tc,
            ),
          };
        }));
        break;

      case 'subagent-start':
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? {
                ...m,
                subagentEvents: [
                  ...(m.subagentEvents ?? []),
                  { ...data, status: 'running' } as SubagentEvent,
                ],
              }
            : m,
        ));
        break;

      case 'subagent-complete':
        setMessages(prev => prev.map(m => {
          if (m.id !== assistantId) return m;
          return {
            ...m,
            subagentEvents: (m.subagentEvents ?? []).map(se =>
              se.id === data.id ? { ...se, status: 'complete', result: data.result } : se,
            ),
          };
        }));
        break;

      case 'todo-update':
        setTodos(data.todos ?? []);
        break;

      case 'approval-required':
        setPendingApproval(data);
        setIsLoading(false);
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, isStreaming: false, approvalRequest: data } : m,
        ));
        break;

      case 'error':
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: m.content + `\n\n⚠️ ${data.message}`, isStreaming: false } : m,
        ));
        setIsLoading(false);
        break;

      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // HITL Approval handler
  // ---------------------------------------------------------------------------

  async function handleApproval(decisions: ApprovalDecision[]) {
    if (!activeThreadId) return;
    setPendingApproval(null);
    setIsLoading(true);

    const assistantId = uuidv4();
    const placeholder: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      subagentEvents: [],
      toolCalls: [],
      isStreaming: true,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, placeholder]);

    const config = {
      model: selectedModel,
      autoApprove,
      accounts: selectedAccounts,
      selectedSkills,
      mcpServerIds: selectedMcpServers,
    };

    consumeStream(
      '/api/deep-agent/approve',
      { threadId: activeThreadId, decisions, config },
      (event, data) => handleStreamEvent(assistantId, event, data),
      () => {
        setIsLoading(false);
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, isStreaming: false } : m));
      },
      (err) => {
        setIsLoading(false);
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: `Resume error: ${err}`, isStreaming: false } : m,
        ));
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Keyboard handler
  // ---------------------------------------------------------------------------

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-resize textarea
  // ---------------------------------------------------------------------------

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden font-sans">
      {/* ── Left: Thread Sidebar ── */}
      <ThreadSidebar
        threads={threads}
        activeThreadId={activeThreadId}
        onSelectThread={loadThread}
        onNewThread={createNewThread}
        onDeleteThread={deleteThread}
      />

      {/* ── Center: Chat ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-card/80 backdrop-blur-md shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-md shadow-violet-500/20">
              <Brain className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-foreground leading-tight">Deep Agent</h1>
              <p className="text-[11px] text-muted-foreground leading-tight">
                {autoApprove ? 'Auto-approve enabled' : 'Manual approval mode'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Auto-approve toggle */}
            <button
              onClick={() => setAutoApprove(v => !v)}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border',
                autoApprove
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25 hover:bg-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 hover:bg-amber-500/15',
              )}
            >
              <Shield className="w-3.5 h-3.5" />
              {autoApprove ? 'Auto Approve ON' : 'Approval Required'}
            </button>

            {/* Todo panel toggle */}
            <button
              onClick={() => setShowTodos(v => !v)}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
              title={showTodos ? 'Hide plan panel' : 'Show plan panel'}
            >
              {showTodos ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto scroll-smooth">
          <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
            {messages.length === 0 && (
              <EmptyState />
            )}

            {messages.map(msg => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isLoading={isLoading && !!msg.isStreaming}
              />
            ))}

            {/* Pending approval inline */}
            {pendingApproval && (
              <ApprovalDialog
                approval={pendingApproval}
                onDecide={handleApproval}
              />
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input area */}
        <div className="border-t border-border bg-card/50 backdrop-blur-sm px-4 py-3 shrink-0">
          <div className="max-w-4xl mx-auto">
            {/* Model + MCP/Skill selectors */}
            <div className="flex items-center gap-2 mb-2.5 flex-wrap">
              <select
                value={selectedModel}
                onChange={e => setSelectedModel(e.target.value)}
                className="text-xs bg-muted border border-border text-foreground rounded-lg px-2.5 py-1.5 outline-none focus:border-violet-500/50 transition-colors cursor-pointer"
              >
                {MODELS.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>

              <McpSkillSelector
                selectedSkills={selectedSkills}
                onSkillsChange={setSelectedSkills}
                selectedMcpServers={selectedMcpServers}
                onMcpServersChange={setSelectedMcpServers}
              />

              {isLoading && (
                <div className="flex items-center gap-1.5 text-xs text-violet-500 dark:text-violet-400 ml-auto">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Agent is running…</span>
                </div>
              )}
            </div>

            {/* Textarea + Send */}
            <div className={cn(
              'relative bg-background border rounded-xl overflow-hidden transition-all duration-200',
              isLoading
                ? 'border-border'
                : 'border-border focus-within:border-violet-500/60 focus-within:shadow-sm focus-within:shadow-violet-500/10',
            )}>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                placeholder="Describe your DevOps task… (Shift+Enter for newline)"
                rows={2}
                style={{ minHeight: '52px', maxHeight: '200px' }}
                className="w-full bg-transparent px-4 pt-3 pb-11 text-sm text-foreground placeholder:text-muted-foreground outline-none resize-none overflow-y-auto"
                disabled={isLoading}
              />
              <div className="absolute bottom-2.5 right-2.5">
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isLoading}
                  className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center transition-all',
                    input.trim() && !isLoading
                      ? 'bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-500/30 hover:shadow-violet-500/50 hover:scale-105 active:scale-95'
                      : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50',
                  )}
                >
                  {isLoading
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Send className="w-3.5 h-3.5" />
                  }
                </button>
              </div>
            </div>

            <p className="text-center text-[10px] text-muted-foreground mt-1.5">
              Deep Agent • Subagents: aws-ops · research · code-iac • Memory: thread-scoped + cross-thread
            </p>
          </div>
        </div>
      </div>

      {/* ── Right: Todo Panel ── */}
      {showTodos && (
        <TodoPanel
          todos={todos}
          threadId={activeThreadId}
          onTodosChange={setTodos}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-8 py-16">
      <div className="relative">
        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-500/20 to-indigo-600/20 border border-violet-500/20 flex items-center justify-center shadow-lg shadow-violet-500/10">
          <Brain className="w-10 h-10 text-violet-500 dark:text-violet-400" />
        </div>
        <div className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-500 border-2 border-background flex items-center justify-center shadow-sm">
          <Sparkles className="w-3 h-3 text-white" />
        </div>
      </div>
      <div className="text-center max-w-md">
        <h2 className="text-xl font-semibold text-foreground mb-2">Deep Agent</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          An AI orchestrator with specialized subagents for AWS operations, research, and Infrastructure as Code.
          Maintains memory across all of your conversations.
        </p>
      </div>
      <div className="flex flex-wrap gap-2 justify-center max-w-lg">
        {[
          { icon: Zap, label: 'AWS Operations', color: 'amber' },
          { icon: Brain, label: 'Research', color: 'violet' },
          { icon: Terminal, label: 'Code & IaC', color: 'cyan' },
          { icon: MemoryStick, label: 'Long-term memory', color: 'emerald' },
          { icon: Shield, label: 'Human-in-the-loop', color: 'rose' },
        ].map(({ icon: Icon, label, color }) => (
          <div
            key={label}
            className={cn(
              'flex items-center gap-2 px-3.5 py-2 rounded-full text-xs font-medium border',
              color === 'amber' && 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
              color === 'violet' && 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
              color === 'cyan' && 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
              color === 'emerald' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
              color === 'rose' && 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message Bubble
// ---------------------------------------------------------------------------

function MessageBubble({ message, isLoading }: { message: ChatMessage; isLoading?: boolean }) {
  const isUser = message.role === 'user';
  const hasSubagents = (message.subagentEvents ?? []).length > 0;
  const hasToolCalls = (message.toolCalls ?? []).length > 0;

  return (
    <div className={cn('flex gap-3', isUser ? 'justify-end' : 'justify-start')}>
      {/* Agent avatar */}
      {!isUser && (
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shrink-0 mt-0.5 shadow-md shadow-violet-500/20">
          <Brain className="w-4 h-4 text-white" />
        </div>
      )}

      <div className={cn(
        'min-w-0 flex flex-col gap-2',
        isUser ? 'items-end max-w-[65%]' : 'items-start flex-1 max-w-[85%]',
      )}>
        {/* Subagent cards */}
        {hasSubagents && (
          <div className="w-full space-y-2">
            {message.subagentEvents!.map(evt => (
              <SubagentCard key={evt.id} event={evt} />
            ))}
          </div>
        )}

        {/* Tool calls */}
        {hasToolCalls && (
          <div className="w-full space-y-1.5">
            {message.toolCalls!.map(tc => (
              <ToolCallBlock key={tc.toolCallId} toolCall={tc} />
            ))}
          </div>
        )}

        {/* Main message bubble */}
        {(message.content || isLoading) && (
          <div
            className={cn(
              'relative text-sm leading-relaxed',
              isUser
                ? 'bg-gradient-to-br from-violet-600 to-indigo-700 text-white rounded-2xl rounded-tr-sm px-4 py-3 shadow-md shadow-violet-500/20'
                : 'bg-card border border-border text-foreground rounded-2xl rounded-tl-sm px-4 py-3 w-full',
            )}
          >
            {isUser ? (
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            ) : (
              <>
                <div className="prose dark:prose-invert prose-sm max-w-none
                  prose-p:my-2 prose-p:leading-relaxed
                  prose-headings:font-semibold prose-headings:text-foreground
                  prose-strong:text-foreground prose-strong:font-semibold
                  prose-code:text-violet-600 dark:prose-code:text-violet-300 prose-code:bg-violet-500/10 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.8em] prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
                  prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-pre:rounded-xl prose-pre:text-[0.8em]
                  prose-blockquote:border-l-violet-500 prose-blockquote:text-muted-foreground
                  prose-table:w-full
                  prose-th:bg-muted prose-th:border prose-th:border-border prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:text-xs prose-th:font-semibold prose-th:text-foreground
                  prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2 prose-td:text-xs
                  prose-a:text-violet-600 dark:prose-a:text-violet-400 prose-a:no-underline hover:prose-a:underline
                  prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
                ">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {message.content || ''}
                  </ReactMarkdown>
                </div>
                {isLoading && (
                  <span className="inline-flex gap-0.5 ml-0.5 align-bottom">
                    <span className="inline-block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="inline-block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="inline-block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {/* Timestamp */}
        <span className="text-[10px] text-muted-foreground px-1 select-none">
          {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* User avatar */}
      {isUser && (
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500/20 to-indigo-600/20 border border-violet-500/25 flex items-center justify-center shrink-0 mt-0.5">
          <User className="w-4 h-4 text-violet-500 dark:text-violet-400" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool Call Block
// ---------------------------------------------------------------------------

function ToolCallBlock({ toolCall }: { toolCall: ToolCallItem }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const isComplete = !!toolCall.result;

  function copyOutput() {
    if (toolCall.result) {
      navigator.clipboard.writeText(toolCall.result);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className={cn(
      'rounded-xl border overflow-hidden text-xs transition-all',
      isComplete
        ? 'border-emerald-500/20 bg-emerald-500/5'
        : 'border-amber-500/20 bg-amber-500/5',
    )}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        {/* Status icon */}
        {isComplete
          ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
          : <Loader2 className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0 animate-spin" />
        }

        {/* Tool name */}
        <span className={cn(
          'font-mono font-semibold flex-1 truncate',
          isComplete
            ? 'text-emerald-700 dark:text-emerald-300'
            : 'text-amber-700 dark:text-amber-300',
        )}>
          {toolCall.toolName}
        </span>

        {/* Status label */}
        <span className={cn(
          'text-[10px] font-medium px-2 py-0.5 rounded-full border',
          isComplete
            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/25'
            : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25',
        )}>
          {isComplete ? 'Complete' : 'Pending'}
        </span>

        {open
          ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        }
      </button>

      {open && (
        <div className="border-t border-border/50 divide-y divide-border/50">
          {/* Input */}
          <div className="p-3">
            <p className="text-[10px] font-bold tracking-wider uppercase text-muted-foreground mb-2">Input</p>
            <pre className="text-foreground bg-muted border border-border rounded-lg p-2.5 overflow-x-auto text-[11px] whitespace-pre-wrap break-words leading-relaxed max-h-48">
              {JSON.stringify(toolCall.args, null, 2)}
            </pre>
          </div>

          {/* Output */}
          {toolCall.result && (
            <div className="p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold tracking-wider uppercase text-muted-foreground">Output</p>
                <button
                  onClick={copyOutput}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-accent"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="text-foreground bg-muted border border-border rounded-lg p-2.5 overflow-x-auto text-[11px] max-h-56 whitespace-pre-wrap break-words leading-relaxed">
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
