'use client';

import { useChat } from '@ai-sdk/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Send, Bot, User, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export function ChatInterface() {
  const [input, setInput] = useState('');
  const { messages, sendMessage, status } = useChat({
    api: '/api/chat',
  } as any);
  
  const isLoading = status === 'streaming' || status === 'submitted';

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input?.trim() || isLoading) return;
    
    const text = input.trim();
    setInput('');
    
    // Send message using the text property which AbstractChat supports
    await sendMessage({ 
        text: text
    } as any); 
  };

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
        scrollRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  return (
    <div className="flex flex-col h-[calc(100vh-theme(spacing.16))] md:h-[calc(100vh-6rem)] max-w-4xl mx-auto w-full border rounded-xl overflow-hidden shadow-sm bg-background">
      {/* Header */}
      <div className="p-4 border-b bg-muted/30 flex items-center gap-2">
        <Bot className="w-5 h-5 text-primary" />
        <h2 className="font-semibold">Nucleus DevOps Agent</h2>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground py-10">
              <Bot className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Hello! I'm your DevOps assistant.</p>
              <p className="text-sm">I can help you inspect and troubleshoot your AWS resources.</p>
              <p className="text-xs mt-2 text-muted-foreground/60">Try asking: "List my running EC2 instances"</p>
            </div>
          )}
          
          {messages.map((m: any) => (
            <div key={m.id} className={cn("flex gap-3", m.role === 'user' ? "justify-end" : "justify-start")}>
              {m.role !== 'user' && (
                <Avatar className="w-8 h-8 border">
                  <AvatarFallback className="bg-primary/10"><Bot className="w-4 h-4" /></AvatarFallback>
                </Avatar>
              )}
              
              <div className={cn(
                "rounded-lg px-4 py-2 max-w-[80%]",
                m.role === 'user' 
                  ? "bg-primary text-primary-foreground" 
                  : "bg-secondary text-secondary-foreground"
              )}>
                 {/* Text Content */}
                 <div className="whitespace-pre-wrap">
                    {m.content || (m.parts?.map((p: any, i: number) => {
                        if (p.type === 'text') return <span key={i}>{p.text}</span>;
                        return null;
                    }))}
                 </div>

                 {/* Tool Invocations */}
                 {m.toolInvocations?.map((toolInvocation: any) => {
                    const toolCallId = toolInvocation.toolCallId;
                    // Type guard for 'result' property (it exists when state is 'result')
                    const hasResult = 'result' in toolInvocation;
                    
                    if (!hasResult) {
                         return (
                            <div key={toolCallId} className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
                                <Terminal className="w-3 h-3 animate-pulse" />
                                <span>Executing plan...</span>
                            </div>
                         );
                    } else {
                         return (
                            <div key={toolCallId} className="mt-2 p-2 bg-black/5 dark:bg-white/5 rounded text-xs font-mono overflow-x-auto">
                                <div className="flex items-center gap-1 mb-1 opacity-70">
                                    <Terminal className="w-3 h-3" />
                                    <span>Execution Output:</span>
                                </div>
                                <pre className="max-h-32 overflow-y-auto">{toolInvocation.result}</pre>
                            </div>
                         );
                    }
                 })}
              </div>

              {m.role === 'user' && (
                <Avatar className="w-8 h-8 border">
                  <AvatarFallback className="bg-muted"><User className="w-4 h-4" /></AvatarFallback>
                </Avatar>
              )}
            </div>
          ))}
          
          {/* Invisible anchor for scrolling */}
          <div ref={scrollRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="p-4 border-t bg-background">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input 
            value={input} 
            onChange={handleInputChange} 
            placeholder="Describe your issue or ask a question..." 
            className="flex-1"
            disabled={isLoading}
          />
          <Button type="submit" disabled={isLoading || !input.trim()}>
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
