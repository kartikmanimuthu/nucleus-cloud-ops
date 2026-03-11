"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Bot, Send, Sparkles, Trash2, User } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { KBChatSources, KBSource } from "./kb-chat-sources";
import type { KnowledgeBase } from "@/lib/knowledge-base/types";

// ============================================================================
// Example prompts
// ============================================================================

const EXAMPLE_PROMPTS = [
  "What does this document say about...?",
  "Summarize the key points",
  "Find information about...",
  "What are the main topics covered?",
];

// ============================================================================
// Types
// ============================================================================

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: KBSource[];
};

interface KBChatProps {
  initialKbId?: string;
}

// ============================================================================
// Component
// ============================================================================

export function KBChat({ initialKbId }: KBChatProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // KB selector
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [selectedKbId, setSelectedKbId] = useState<string>(initialKbId || "");

  // Fetch knowledge base list
  useEffect(() => {
    fetch("/api/knowledge-base")
      .then((r) => r.json())
      .then((data: { knowledgeBases?: KnowledgeBase[] }) => {
        setKnowledgeBases(data.knowledgeBases || []);
      })
      .catch(() => {/* silently ignore */});
  }, []);

  // Auto-scroll to bottom as messages stream in
  useEffect(() => {
    if (scrollRef.current) {
      const viewport = scrollRef.current.querySelector(
        "[data-radix-scroll-area-viewport]",
      );
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleSend = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading || isStreaming) return;

    setInput("");
    setError(null);

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: trimmed,
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setIsLoading(true);

    try {
      // Build conversation history (all prior messages except the one we just added)
      const conversationHistory = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await fetch("/api/knowledge-base/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          knowledgeBaseId: selectedKbId || undefined,
          messages: conversationHistory,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      // Parse sources from header before consuming body stream
      const msgId = "ai-" + Date.now();
      const sourcesHeader = response.headers.get("X-AI-Sources");
      let sources: KBSource[] = [];
      if (sourcesHeader) {
        try {
          sources = JSON.parse(decodeURIComponent(sourcesHeader)) as KBSource[];
        } catch {/* ignore */}
      }

      // Add empty assistant message, then stream content into it
      setMessages((prev) => [
        ...prev,
        { id: msgId, role: "assistant", content: "", sources },
      ]);
      setIsLoading(false);
      setIsStreaming(true);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let content = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        content += decoder.decode(value, { stream: true });
        setMessages((prev) =>
          prev.map((m) => (m.id === msgId ? { ...m, content } : m)),
        );
      }

      setIsStreaming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get response");
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
    }
  };

  const handleClearConversation = () => {
    setMessages([]);
    setError(null);
    setInput("");
    setIsStreaming(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* KB Selector bar */}
      <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0">
        <span className="text-sm text-muted-foreground font-medium whitespace-nowrap">
          Knowledge Base:
        </span>
        <Select value={selectedKbId} onValueChange={setSelectedKbId}>
          <SelectTrigger className="w-64 h-8 text-sm">
            <SelectValue placeholder="All Knowledge Bases" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All Knowledge Bases</SelectItem>
            {knowledgeBases.map((kb) => (
              <SelectItem key={kb.id} value={kb.id}>
                {kb.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearConversation}
            className="text-muted-foreground h-8 px-2 ml-auto"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            New chat
          </Button>
        )}
      </div>

      {/* Conversation area */}
      <ScrollArea className="flex-1 px-6" ref={scrollRef}>
        <div className="space-y-4 py-4">
          {/* Empty state */}
          {messages.length === 0 && !isLoading && (
            <div className="flex flex-col items-center justify-center pt-16 text-center animate-in fade-in zoom-in duration-300">
              <div className="bg-primary/10 p-4 rounded-full mb-4">
                <Sparkles className="h-8 w-8 text-primary" />
              </div>
              <h3 className="font-semibold text-lg mb-1">How can I help you?</h3>
              <p className="text-sm text-muted-foreground max-w-sm mb-6">
                Ask questions about your knowledge base documents using natural language.
              </p>
              <div className="grid grid-cols-1 gap-2 w-full max-w-md">
                {EXAMPLE_PROMPTS.map((p) => (
                  <button
                    key={p}
                    onClick={() => handleSend(p)}
                    className="text-left text-sm bg-background border rounded-md px-3 py-2 hover:bg-muted/60 transition-colors"
                  >
                    &ldquo;{p}&rdquo;
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((message) => (
            <div
              key={message.id}
              className="animate-in slide-in-from-bottom-2 duration-200"
            >
              {message.role === "user" ? (
                <div className="flex gap-3 justify-end">
                  <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2 text-sm max-w-[75%]">
                    {message.content}
                  </div>
                  <div className="mt-0.5 bg-muted p-2 rounded-lg h-fit shrink-0">
                    <User className="h-4 w-4" />
                  </div>
                </div>
              ) : (
                <div className="flex gap-3">
                  <div className="mt-0.5 bg-indigo-500/10 p-2 rounded-lg h-fit shrink-0">
                    <Bot className="h-4 w-4 text-indigo-600" />
                  </div>
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                      <ReactMarkdown>{message.content}</ReactMarkdown>
                    </div>
                    {message.sources && message.sources.length > 0 && (
                      <KBChatSources sources={message.sources} />
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Loading indicator */}
          {isLoading && (
            <div className="flex gap-3 animate-in fade-in duration-200">
              <div className="mt-0.5 bg-indigo-500/10 p-2 rounded-lg h-fit shrink-0">
                <Bot className="h-4 w-4 text-indigo-600" />
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground text-sm pt-2">
                <span
                  className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce"
                  style={{ animationDelay: "0ms" }}
                />
                <span
                  className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce"
                  style={{ animationDelay: "300ms" }}
                />
                <span className="ml-1">Thinking...</span>
              </div>
            </div>
          )}

          {/* Error state */}
          {error && (
            <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 text-sm">
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className="px-6 py-4 border-t shrink-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend(input);
          }}
          className="flex gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question about your documents..."
            disabled={isLoading || isStreaming}
            className="flex-1"
            autoFocus
          />
          <Button
            type="submit"
            disabled={isLoading || isStreaming || !input.trim()}
          >
            <Send className="h-4 w-4" />
            <span className="sr-only">Send</span>
          </Button>
        </form>
        <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
          Answers are based on the documents in your knowledge base.
        </p>
      </div>
    </div>
  );
}
