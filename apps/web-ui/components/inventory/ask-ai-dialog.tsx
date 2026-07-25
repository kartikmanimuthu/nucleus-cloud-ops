"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { MicButton } from "@/components/voice/mic-button";
import { Bot, Send, Sparkles, User, RefreshCw, Trash2, ChevronDown } from "lucide-react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useRef, useState, useId } from "react";
import { cn } from "@/lib/utils";

// Example prompts shown in the empty state
const EXAMPLE_PROMPTS = [
    "How many EC2 instances are running?",
    "List all RDS databases in us-east-1",
    "Show resources tagged with Environment=Production",
    "Which Lambda functions have a timeout over 5 minutes?",
];

// Suggested follow-ups (shown after each AI response)
const FOLLOW_UPS = [
    "Tell me more about the first resource",
    "Filter those by region us-east-1",
    "Which of these are in a stopped state?",
];

export interface ActiveFilters {
    accountId?: string;
    region?: string;
    resourceType?: string;
}

interface AskAIDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Active filters from the inventory grid — pre-populate context */
    filters?: ActiveFilters;
}

export function AskAIDialog({ open, onOpenChange, filters }: AskAIDialogProps) {
    const conversationId = useId();
    const scrollRef = useRef<HTMLDivElement>(null);
    const [showFollowUps, setShowFollowUps] = useState(false);
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<Array<{ id: string; role: string; content: string }>>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [error, setError] = useState<{ message: string } | null>(null);
    const [steps, setSteps] = useState<Array<{ name: string; status: 'running' | 'done'; detail?: string }>>([]);
    const [sqlQuery, setSqlQuery] = useState('');
    const [sqlExpanded, setSqlExpanded] = useState(false);

    const handleSend = async (text: string) => {
        const trimmed = text.trim();
        if (!trimmed || isLoading || isStreaming) return;

        setInput('');
        setShowFollowUps(false);
        setError(null);
        
        const userMessage = { id: Date.now().toString(), role: 'user', content: trimmed };
        setMessages(prev => [...prev, userMessage]);
        setIsLoading(true);

        try {
            const response = await fetch('/api/ask-ai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [...messages, userMessage],
                    conversationId,
                    filters: filters && Object.values(filters).some(Boolean) ? filters : undefined,
                }),
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const msgId = 'ai-' + Date.now();
            setMessages(prev => [...prev, { id: msgId, role: 'assistant', content: '' }]);
            setIsLoading(false);
            setIsStreaming(true);
            setSteps([]);
            setSqlQuery('');

            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let content = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const event = JSON.parse(line.slice(6));

                        switch (event.type) {
                            case 'step':
                                setSteps(prev => {
                                    const existing = prev.find(s => s.name === event.step);
                                    if (existing) {
                                        return prev.map(s => s.name === event.step
                                            ? { ...s, status: event.status, detail: event.detail }
                                            : s
                                        );
                                    }
                                    return [...prev, { name: event.step, status: event.status, detail: event.detail }];
                                });
                                break;
                            case 'sql':
                                setSqlQuery(event.query);
                                break;
                            case 'result':
                                setSteps(prev => prev.map(s => s.name === 'execute_sql'
                                    ? { ...s, detail: `${event.rowCount} rows` }
                                    : s
                                ));
                                break;
                            case 'token':
                                content += event.content;
                                setMessages(prev => prev.map(m => m.id === msgId ? { ...m, content } : m));
                                break;
                            case 'error':
                                setError({ message: event.message });
                                break;
                            case 'done':
                                break;
                        }
                    } catch { /* skip malformed lines */ }
                }
            }

            setIsStreaming(false);
            setShowFollowUps(true);
        } catch (err) {
            setError({ message: err instanceof Error ? err.message : 'Failed to get response' });
        } finally {
            setIsLoading(false);
            setIsStreaming(false);
        }
    };

    // Auto-scroll to bottom as messages stream in
    useEffect(() => {
        if (scrollRef.current) {
            const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
            if (viewport) viewport.scrollTop = viewport.scrollHeight;
        }
    }, [messages, isLoading]);

    const handleClearConversation = () => {
        setMessages([]);
        setShowFollowUps(false);
        setInput('');
        setIsStreaming(false);
        setSteps([]);
        setSqlQuery('');
        setSqlExpanded(false);
    };

    const handleFollowUpClick = (text: string) => handleSend(text);

    const activeFilterCount = filters
        ? Object.values(filters).filter(Boolean).length
        : 0;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl h-[680px] flex flex-col gap-0 p-0">
                {/* Header */}
                <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
                    <div className="flex items-center justify-between">
                        <DialogTitle className="flex items-center gap-2">
                            <Sparkles className="h-5 w-5 text-indigo-500" />
                            Ask AI about your inventory
                        </DialogTitle>
                        {messages.length > 0 && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleClearConversation}
                                className="text-muted-foreground h-7 px-2"
                            >
                                <Trash2 className="h-3.5 w-3.5 mr-1" />
                                New chat
                            </Button>
                        )}
                    </div>
                    <DialogDescription className="flex items-center gap-2 flex-wrap">
                        Ask questions about your AWS resources using natural language.
                        {activeFilterCount > 0 && (
                            <span className="flex items-center gap-1">
                                <span className="text-xs">Active filters:</span>
                                {filters?.accountId && (
                                    <Badge variant="secondary" className="text-xs h-5">
                                        Account: {filters.accountId}
                                    </Badge>
                                )}
                                {filters?.region && (
                                    <Badge variant="secondary" className="text-xs h-5">
                                        {filters.region}
                                    </Badge>
                                )}
                                {filters?.resourceType && (
                                    <Badge variant="secondary" className="text-xs h-5">
                                        {filters.resourceType}
                                    </Badge>
                                )}
                            </span>
                        )}
                    </DialogDescription>
                </DialogHeader>

                {/* Conversation area */}
                <ScrollArea className="flex-1 px-6 border-t" ref={scrollRef}>
                    <div className="space-y-4 py-4">

                        {/* Empty state with example prompts */}
                        {messages.length === 0 && !isLoading && (
                            <div className="flex flex-col items-center justify-center pt-12 text-center animate-in fade-in zoom-in duration-300">
                                <div className="bg-primary/10 p-4 rounded-full mb-4">
                                    <Sparkles className="h-8 w-8 text-primary" />
                                </div>
                                <h3 className="font-semibold text-lg mb-1">How can I help you?</h3>
                                <p className="text-sm text-muted-foreground max-w-sm mb-6">
                                    I can answer questions about your discovered AWS resources across all connected accounts.
                                </p>
                                <div className="grid grid-cols-1 gap-2 w-full max-w-md">
                                    {EXAMPLE_PROMPTS.map((p) => (
                                        <button
                                            key={p}
                                            onClick={() => handleFollowUpClick(p)}
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
                            <div key={message.id} className="animate-in slide-in-from-bottom-2 duration-200">
                                {message.role === "user" ? (
                                    <div className="flex gap-3 justify-end">
                                        <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2 text-sm max-w-[75%]">
                                            {message.content as string}
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
                                            {/* Step indicators */}
                                            {message.id === messages.filter(m => m.role === 'assistant').at(-1)?.id && steps.length > 0 && (
                                                <div className="flex flex-wrap gap-1.5 mb-3">
                                                    {steps.map((step) => (
                                                        <div key={step.name} className={cn(
                                                            "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border",
                                                            step.status === 'done'
                                                                ? "bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400"
                                                                : "bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400 animate-pulse"
                                                        )}>
                                                            {step.status === 'done' ? '✓' : '⟳'} {step.name.replace(/_/g, ' ')}{step.detail ? ` (${step.detail})` : ''}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                            {/* Collapsible SQL block */}
                                            {message.id === messages.filter(m => m.role === 'assistant').at(-1)?.id && sqlQuery && (
                                                <div className="mb-3 rounded-md border bg-muted/30 overflow-hidden">
                                                    <button
                                                        onClick={() => setSqlExpanded(!sqlExpanded)}
                                                        className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
                                                    >
                                                        <span>SQL Query</span>
                                                        <ChevronDown className={cn("h-3 w-3 transition-transform", sqlExpanded && "rotate-180")} />
                                                    </button>
                                                    {sqlExpanded && (
                                                        <pre className="px-3 py-2 text-xs overflow-x-auto border-t bg-muted/20 font-mono">{sqlQuery}</pre>
                                                    )}
                                                </div>
                                            )}
                                            <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                    {message.content as string}
                                                </ReactMarkdown>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}

                        {/* Streaming indicator — shown while waiting for first chunk */}
                        {isLoading && (
                            <div className="flex gap-3 animate-in fade-in duration-200">
                                <div className="mt-0.5 bg-indigo-500/10 p-2 rounded-lg h-fit shrink-0">
                                    <Bot className="h-4 w-4 text-indigo-600" />
                                </div>
                                <div className="flex items-center gap-1.5 text-muted-foreground text-sm pt-2">
                                    <span className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                                    <span className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                                    <span className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                                    <span className="ml-1">Thinking...</span>
                                </div>
                            </div>
                        )}

                        {/* Error state */}
                        {error && (
                            <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 text-sm flex items-center justify-between">
                                <span><strong>Error:</strong> {error.message}</span>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleSend(input)}
                                    className="text-red-600 border-red-500/30 ml-3 h-7"
                                >
                                    <RefreshCw className="h-3 w-3 mr-1" />
                                    Retry
                                </Button>
                            </div>
                        )}

                        {/* Follow-up suggestions */}
                        {showFollowUps && !isLoading && messages.length > 0 && (
                            <div className="animate-in fade-in duration-300">
                                <p className="text-xs text-muted-foreground mb-1.5">Suggested follow-ups:</p>
                                <div className="flex flex-wrap gap-1.5">
                                    {FOLLOW_UPS.map((fu) => (
                                        <button
                                            key={fu}
                                            onClick={() => handleFollowUpClick(fu)}
                                            className="text-xs px-2.5 py-1 rounded-full border bg-background hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground"
                                        >
                                            {fu}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </ScrollArea>

                {/* Input area */}
                <div className="px-6 py-4 border-t shrink-0">
                    <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="flex gap-2">
                        <Input
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Ask a question about your inventory..."
                            disabled={isLoading || isStreaming}
                            className="flex-1"
                            autoFocus
                        />
                        <MicButton
                            value={input}
                            onChange={setInput}
                            disabled={isLoading || isStreaming}
                            className="self-center"
                        />
                        <Button type="submit" disabled={isLoading || isStreaming || !input.trim()}>
                            <Send className="h-4 w-4" />
                            <span className="sr-only">Send</span>
                        </Button>
                    </form>
                    <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
                        Answers are based on your last inventory sync. Run a new sync to get latest data.
                    </p>
                </div>
            </DialogContent>
        </Dialog>
    );
}
