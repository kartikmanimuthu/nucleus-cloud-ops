'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { 
  MessageSquare, 
  Trash2, 
  Plus, 
  Search,
  MoreVertical,
  Sidebar
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { formatDistanceToNow } from 'date-fns';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface Thread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
}

interface ThreadSidebarProps {
    className?: string;
    currentThreadId: string;
    openTabIds?: string[];
    onThreadSelect: (threadId: string) => void;
    onNewChat: () => void;
}

export function ThreadSidebar({
    className,
    currentThreadId,
    openTabIds = [],
    onThreadSelect,
    onNewChat
}: ThreadSidebarProps) {
    const [threads, setThreads] = useState<Thread[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    const fetchThreads = async () => {
        try {
            const res = await fetch('/api/threads');
            if (res.ok) {
                const data = await res.json();
                setThreads(data);
            }
        } catch (e) {
            console.error("Failed to fetch threads", e);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchThreads();
        // Poll for updates every 10s or relies on parent to trigger refresh?
        // Simple polling for now
        // const interval = setInterval(fetchThreads, 300000);
        // return () => clearInterval(interval);
    }, []);

    const handleDeleteThread = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        try {
            const res = await fetch(`/api/threads/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setThreads(threads.filter(t => t.id !== id));
                if (currentThreadId === id) {
                    onNewChat();
                }
            }
        } catch (e) {
            console.error("Failed to delete thread", e);
        }
    };

    const filteredThreads = threads.filter(t => 
        t.title.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className={cn("flex flex-col h-full bg-muted/10 border-r", className)}>
            {/* Header */}
            <div className="p-4 border-b space-y-3">
                <Button 
                    onClick={onNewChat} 
                    className="w-full justify-start gap-2"
                >
                    <Plus className="w-4 h-4" />
                    New Chat
                </Button>
                
                <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search threads..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-8 h-9 text-xs"
                    />
                </div>
            </div>

            {/* List */}
            <ScrollArea className="flex-1">
                <div className="p-2 space-y-1">
                    {filteredThreads.map(thread => (
                        <div
                            key={thread.id}
                            onClick={() => onThreadSelect(thread.id)}
                            className={cn(
                                "group flex flex-col gap-1 p-3 rounded-lg text-sm transition-colors cursor-pointer hover:bg-accent/50 relative",
                                currentThreadId === thread.id ? "bg-accent shadow-sm" : "transparent"
                            )}
                        >
                            <div className="flex items-start justify-between gap-2">
                                <span className="font-medium truncate leading-tight">
                                    {thread.title || "Untitled Conversation"}
                                </span>
                                {openTabIds.includes(thread.id) && (
                                    <span className="shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-primary/10 text-primary leading-none">
                                        Open
                                    </span>
                                )}
                                
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                                        <Button variant="ghost" size="icon" className="h-6 w-6 -mt-1 -mr-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <MoreVertical className="h-3 w-3" />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuItem 
                                            className="text-destructive focus:text-destructive"
                                            onClick={(e) => handleDeleteThread(e as any, thread.id)}
                                        >
                                            <Trash2 className="w-4 h-4 mr-2" />
                                            Delete
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                            
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                <span>{formatDistanceToNow(thread.updatedAt, { addSuffix: true })}</span>
                                <span className="font-mono text-xs opacity-50">#{thread.id.slice(-4)}</span>
                            </div>
                        </div>
                    ))}
                    
                    {filteredThreads.length === 0 && !isLoading && (
                        <div className="text-center py-8 text-xs text-muted-foreground">
                            No threads found.
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
}
