"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, Send, Sparkles } from "lucide-react";
import { useCompletion } from '@ai-sdk/react';
import ReactMarkdown from 'react-markdown';
import { useEffect, useRef } from "react";

interface AskAIDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function AskAIDialog({ open, onOpenChange }: AskAIDialogProps) {
    const { completion, input, handleInputChange, handleSubmit, isLoading, error } = useCompletion({
        api: '/api/ask-ai',
    });

    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom of response
    useEffect(() => {
        if (scrollRef.current) {
            const scrollElement = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
            if (scrollElement) {
                scrollElement.scrollTop = scrollElement.scrollHeight;
            }
        }
    }, [completion, isLoading]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl h-[600px] flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-indigo-500" />
                        Ask AI Assistant
                    </DialogTitle>
                    <DialogDescription>
                        Ask questions about your inventory, resources, and configurations.
                    </DialogDescription>
                </DialogHeader>

                <ScrollArea className="flex-1 pr-4 border rounded-md p-4 bg-muted/30" ref={scrollRef}>
                    <div className="space-y-4">
                        {/* Empty State */}
                        {!completion && !isLoading && !error && (
                            <div className="flex flex-col items-center justify-center h-full pt-20 text-muted-foreground text-center animate-in fade-in zoom-in duration-300">
                                <div className="bg-primary/10 p-4 rounded-full mb-4">
                                    <Sparkles className="h-8 w-8 text-primary" />
                                </div>
                                <h3 className="font-semibold text-lg text-foreground mb-1">How can I help you?</h3>
                                <p className="text-sm max-w-xs mb-6">
                                    I can analyze your inventory data and answer questions about your resources.
                                </p>
                                <div className="grid grid-cols-1 gap-2 text-xs">
                                    <div className="bg-background border rounded px-3 py-2">"How many EC2 instances are running?"</div>
                                    <div className="bg-background border rounded px-3 py-2">"List all RDS databases in us-east-1"</div>
                                    <div className="bg-background border rounded px-3 py-2">"Show me resources tagged with Environment=Production"</div>
                                </div>
                            </div>
                        )}

                        {/* Error Message */}
                        {error && (
                            <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 text-sm">
                                <strong>Error:</strong> {error.message}
                            </div>
                        )}

                        {/* User Question (Implicit) - effectively the input, but we show the answer primarily */}

                        {/* AI Response */}
                        {(completion || isLoading) && (
                            <div className="flex gap-4 animate-in slide-in-from-bottom-2 duration-300">
                                <div className="mt-0.5 bg-indigo-500/10 p-2 rounded-lg h-fit shrink-0">
                                    <Bot className="h-5 w-5 text-indigo-600" />
                                </div>
                                <div className="space-y-2 flex-1 overflow-hidden">
                                    <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                                        <ReactMarkdown>
                                            {completion}
                                        </ReactMarkdown>
                                    </div>
                                    {isLoading && (
                                        <div className="flex items-center gap-2 text-muted-foreground text-xs animate-pulse pt-2">
                                            <span className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                                            <span className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                                            <span className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                                            Thinking...
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </ScrollArea>

                <div className="pt-4">
                    <form onSubmit={handleSubmit} className="flex gap-2">
                        <Input
                            value={input}
                            onChange={handleInputChange}
                            placeholder="Ask a question about your inventory..."
                            disabled={isLoading}
                            className="flex-1"
                            autoFocus
                        />
                        <Button type="submit" disabled={isLoading || !input.trim()}>
                            <Send className="h-4 w-4" />
                            <span className="sr-only">Send</span>
                        </Button>
                    </form>
                </div>
            </DialogContent>
        </Dialog>
    );
}
