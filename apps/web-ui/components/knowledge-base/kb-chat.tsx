"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Bot, Cpu, Sparkles, User } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { KBChatSources, KBSource } from "./kb-chat-sources";
import { KBChatSidebar } from "./kb-chat-sidebar";
import { FileUpload, FileAttachment } from "@/components/agent/file-upload";
import { useKnowledgeBases } from "@/lib/queries/knowledge-base";
import { useKBChatMessages } from "@/lib/queries/kb-chat";
import { useProviderModels, defaultModelId } from "@/lib/queries/providers";
import { queryKeys } from "@/lib/queries/query-keys";

const EXAMPLE_PROMPTS = [
  "Summarize the key points in this knowledge base",
  "What are the main topics covered?",
  "Find information about access controls",
  "What does this document say about security?",
];

type MessageAttachment = { name: string; url: string };

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: KBSource[];
  attachments?: MessageAttachment[];
};

interface KBChatProps {
  initialKbId?: string;
}

export function KBChat({ initialKbId }: KBChatProps) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKbId, setSelectedKbId] = useState<string>(initialKbId || "__all__");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);

  // Active persisted session for this conversation (sent back on each turn).
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Sidebar-selected session to hydrate. Kept separate from sessionId so an
  // active/streaming conversation is never clobbered by a history refetch.
  const [loadId, setLoadId] = useState<string | null>(null);

  const { data: knowledgeBases = [] } = useKnowledgeBases();
  const { data: availableModels = [] } = useProviderModels();
  const { data: history, isFetching: isLoadingHistory } = useKBChatMessages(loadId);

  // Default to the provider's default chat model; keep current selection if still valid.
  useEffect(() => {
    setSelectedModel((prev) =>
      prev && availableModels.some((m) => m.id === prev) ? prev : defaultModelId(availableModels),
    );
  }, [availableModels]);

  // Hydrate the pane when a sidebar session's history arrives.
  useEffect(() => {
    if (!loadId || !history) return;
    setMessages(
      history.messages.map((m, i) => ({
        id: `${loadId}-${i}`,
        role: m.role,
        content: m.content,
        sources: m.sources,
        attachments: m.attachments,
      })),
    );
    setSelectedKbId(history.knowledgeBaseId ?? "__all__");
    setSessionId(loadId);
    setError(null);
    setInput("");
    setLoadId(null);
  }, [loadId, history]);

  // Auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [input]);

  const handleNewChat = () => {
    setSessionId(null);
    setLoadId(null);
    setMessages([]);
    setError(null);
    setInput("");
    setAttachments([]);
  };

  const handleSelectSession = (id: string) => {
    if (id === sessionId || id === loadId) return;
    setLoadId(id);
  };

  const handleSend = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading || isStreaming) return;

    setInput("");
    setError(null);

    // Snapshot + clear pending attachments for this turn.
    const turnAttachments = attachments;
    setAttachments([]);
    const attachmentPayload = turnAttachments.map((f) => ({
      name: f.name,
      contentType: f.type,
      url: `data:${f.type};base64,${f.data}`,
    }));

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: trimmed,
      attachments: attachmentPayload.length > 0
        ? attachmentPayload.map((a) => ({ name: a.name, url: a.url }))
        : undefined,
    };
    const priorMessages = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const res = await fetch("/api/knowledge-base/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          knowledgeBaseId: selectedKbId === "__all__" ? undefined : selectedKbId,
          messages: priorMessages,
          sessionId: sessionId ?? undefined,
          model: selectedModel || undefined,
          attachments: attachmentPayload.length > 0 ? attachmentPayload : undefined,
        }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error || `HTTP ${res.status}`);
      }

      // Adopt the persisted session id (brand-new chats learn it here).
      const newSid = res.headers.get("X-KB-Session-Id");
      if (newSid && newSid !== sessionId) setSessionId(newSid);

      const msgId = "ai-" + Date.now();
      let sources: KBSource[] = [];
      const sourcesHeader = res.headers.get("X-AI-Sources");
      if (sourcesHeader) {
        try { sources = JSON.parse(decodeURIComponent(sourcesHeader)); } catch { /* ignore */ }
      }

      setMessages((prev) => [...prev, { id: msgId, role: "assistant", content: "", sources }]);
      setIsLoading(false);
      setIsStreaming(true);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let content = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          content += decoder.decode(value, { stream: true });
          setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, content } : m));
        }
      } finally {
        reader.releaseLock();
      }
      setIsStreaming(false);
      // Refresh the sidebar so the (new or touched) session moves to the top.
      queryClient.invalidateQueries({ queryKey: queryKeys.kbChat.sessions() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get response");
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
    }
  };

  const isBusy = isLoading || isStreaming;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sessions sidebar */}
      <KBChatSidebar
        className="w-72 shrink-0 hidden md:flex"
        currentSessionId={sessionId}
        onSessionSelect={handleSelectSession}
        onNewChat={handleNewChat}
      />

      {/* Chat column */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-3 border-b shrink-0 bg-background">
          <span className="text-sm text-muted-foreground font-medium whitespace-nowrap">Knowledge Base:</span>
          <Select value={selectedKbId} onValueChange={setSelectedKbId}>
            <SelectTrigger className="w-56 h-8 text-sm">
              <SelectValue placeholder="All Knowledge Bases" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Knowledge Bases</SelectItem>
              {knowledgeBases.map((kb) => (
                <SelectItem key={kb.id} value={kb.id}>{kb.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span className="text-sm text-muted-foreground font-medium whitespace-nowrap ml-auto">Model:</span>
          <Select value={selectedModel} onValueChange={setSelectedModel} disabled={availableModels.length === 0}>
            <SelectTrigger className="w-56 h-8 text-sm gap-1.5">
              <Cpu className="h-3.5 w-3.5 text-primary shrink-0" />
              <SelectValue placeholder={availableModels.length === 0 ? "No providers configured" : "Select model"} />
            </SelectTrigger>
            <SelectContent>
              {availableModels.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Messages — only scrolling region */}
        <div className="flex-1 min-h-0 overflow-y-auto" ref={scrollRef}>
          <div className="max-w-3xl mx-auto space-y-6 py-6 px-4 md:px-8">

            {/* Empty state */}
            {messages.length === 0 && !isLoading && !isLoadingHistory && (
              <div className="flex flex-col items-center justify-center pt-16 text-center animate-in fade-in zoom-in duration-300">
                <div className="bg-muted p-4 rounded-full mb-5">
                  <Sparkles className="h-7 w-7 text-foreground" />
                </div>
                <h3 className="font-semibold text-2xl mb-2">How can I help you today?</h3>
                <p className="text-sm text-muted-foreground max-w-md mb-8">
                  Ask questions about your knowledge base documents using natural language.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-xl">
                  {EXAMPLE_PROMPTS.map((p) => (
                    <button
                      key={p}
                      onClick={() => handleSend(p)}
                      className="text-left text-sm bg-background border rounded-xl px-4 py-3 hover:bg-muted/60 hover:border-primary/40 hover:shadow-sm transition-all leading-snug"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* History loading */}
            {isLoadingHistory && messages.length === 0 && (
              <div className="flex justify-center pt-16">
                <div className="flex items-center gap-1">
                  {[0, 150, 300].map((delay) => (
                    <span
                      key={delay}
                      className="h-2 w-2 rounded-full bg-primary/50 animate-bounce"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Message list */}
            {messages.map((msg) => (
              <div key={msg.id} className="animate-in slide-in-from-bottom-2 duration-200">
                {msg.role === "user" ? (
                  /* User bubble — right aligned */
                  <div className="flex gap-3 justify-end">
                    <div className="flex flex-col items-end gap-1.5 max-w-[80%]">
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-2 justify-end">
                          {msg.attachments.map((att, idx) => (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              key={idx}
                              src={att.url}
                              alt={att.name}
                              className="max-h-48 max-w-[12rem] rounded-lg border object-contain bg-background"
                            />
                          ))}
                        </div>
                      )}
                      {msg.content && (
                        <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                          {msg.content}
                        </div>
                      )}
                    </div>
                    <div className="mt-0.5 bg-muted rounded-full p-2 h-fit shrink-0">
                      <User className="h-3.5 w-3.5" />
                    </div>
                  </div>
                ) : (
                  /* Assistant bubble — left aligned */
                  <div className="flex gap-3">
                    <div className="mt-0.5 bg-primary/10 rounded-full p-2 h-fit shrink-0">
                      <Bot className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      {/* Markdown rendered response */}
                      <div className={`
                        prose prose-sm dark:prose-invert max-w-none
                        prose-p:leading-relaxed prose-p:my-1.5
                        prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-1.5
                        prose-h1:text-base prose-h2:text-sm prose-h3:text-sm
                        prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
                        prose-table:text-xs prose-table:border-collapse
                        prose-th:border prose-th:border-border prose-th:px-3 prose-th:py-1.5 prose-th:bg-muted/50 prose-th:font-semibold
                        prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-1.5
                        prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[11px] prose-code:font-mono
                        prose-pre:bg-muted prose-pre:rounded-lg prose-pre:p-3 prose-pre:overflow-x-auto
                        prose-blockquote:border-l-2 prose-blockquote:border-primary/40 prose-blockquote:pl-3 prose-blockquote:text-muted-foreground
                        prose-strong:font-semibold prose-strong:text-foreground
                        break-words
                      `}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content || (isStreaming ? "​" : "")}
                        </ReactMarkdown>
                      </div>
                      {/* Sources */}
                      {msg.sources && msg.sources.length > 0 && (
                        <KBChatSources sources={msg.sources} />
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Thinking indicator */}
            {isLoading && (
              <div className="flex gap-3 animate-in fade-in duration-200">
                <div className="mt-0.5 bg-primary/10 rounded-full p-2 h-fit shrink-0">
                  <Bot className="h-3.5 w-3.5 text-primary" />
                </div>
                <div className="flex items-center gap-1 pt-2.5">
                  {[0, 150, 300].map((delay) => (
                    <span
                      key={delay}
                      className="h-2 w-2 rounded-full bg-primary/50 animate-bounce"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Input area — sticky footer */}
        <div className="px-4 md:px-8 py-4 border-t shrink-0 bg-background">
          <div className="max-w-3xl mx-auto">
            <div className={`flex flex-col gap-1.5 rounded-2xl border bg-background px-3.5 py-2.5 shadow-sm transition-colors focus-within:border-primary/60 focus-within:shadow ${isBusy ? "opacity-60" : ""}`}>
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend(input);
                    }
                  }}
                  placeholder="Ask a question about your documents…"
                  disabled={isBusy}
                  rows={1}
                  className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground min-h-[24px] max-h-[160px] py-0.5 leading-relaxed"
                />
                <Button
                  type="button"
                  size="icon"
                  className="h-9 w-9 shrink-0 rounded-xl"
                  disabled={isBusy || !input.trim()}
                  onClick={() => handleSend(input)}
                >
                  <SendIcon />
                  <span className="sr-only">Send</span>
                </Button>
              </div>
              {/* Image attachments (paperclip + thumbnails) */}
              <FileUpload files={attachments} onFilesChange={setAttachments} disabled={isBusy} />
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
              Answers are based on the documents in your knowledge base · Shift+Enter for new line
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SendIcon() {
  // Paper-plane send glyph (matches the chatbot reference)
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}
