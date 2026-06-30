'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Plus, Search, MoreVertical, Trash2, MessageSquare } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { formatDistanceToNow } from 'date-fns';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useKBChatSessions, useDeleteKBChatSession } from '@/lib/queries/kb-chat';

interface KBChatSidebarProps {
    className?: string;
    currentSessionId: string | null;
    onSessionSelect: (sessionId: string) => void;
    onNewChat: () => void;
}

export function KBChatSidebar({
    className,
    currentSessionId,
    onSessionSelect,
    onNewChat,
}: KBChatSidebarProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const { data: sessions = [], isLoading } = useKBChatSessions();
    const deleteSession = useDeleteKBChatSession();

    const filtered = sessions.filter((s) =>
        s.title.toLowerCase().includes(searchQuery.toLowerCase()),
    );

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        try {
            await deleteSession.mutateAsync(id);
            if (currentSessionId === id) onNewChat();
        } catch {
            /* surfaced via mutation state; sidebar stays usable */
        }
    };

    return (
        <div className={cn('flex flex-col h-full bg-muted/10 border-r', className)}>
            {/* Header */}
            <div className="px-3 pt-3 pb-2 border-b space-y-3">
                <Button onClick={onNewChat} className="w-full justify-start gap-2">
                    <Plus className="w-4 h-4" />
                    New chat
                </Button>
                <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search chats..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-8 h-9 text-xs"
                    />
                </div>
            </div>

            {/* Section label */}
            <div className="px-4 pt-3 pb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Sessions
                </span>
            </div>

            {/* List */}
            <ScrollArea className="flex-1">
                <div className="p-2 pt-1 space-y-1">
                    {isLoading && (
                        <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
                            <Spinner className="w-5 h-5" />
                            <span className="text-xs">Loading sessions...</span>
                        </div>
                    )}

                    {!isLoading &&
                        filtered.map((session) => (
                            <div
                                key={session.id}
                                onClick={() => onSessionSelect(session.id)}
                                className={cn(
                                    'group flex flex-col gap-1 p-3 rounded-lg text-sm transition-colors cursor-pointer hover:bg-accent/50 relative',
                                    currentSessionId === session.id ? 'bg-accent shadow-sm' : 'transparent',
                                )}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="flex items-start gap-2 min-w-0">
                                        <MessageSquare className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                                        <span className="font-medium truncate leading-tight">
                                            {session.title || 'Untitled chat'}
                                        </span>
                                    </div>

                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 -mt-1 -mr-2 opacity-0 group-hover:opacity-100 transition-opacity"
                                            >
                                                <MoreVertical className="h-3 w-3" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                className="text-destructive focus:text-destructive"
                                                onClick={(e) => handleDelete(e as unknown as React.MouseEvent, session.id)}
                                            >
                                                <Trash2 className="w-4 h-4 mr-2" />
                                                Delete
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                                <div className="flex items-center justify-between text-[10px] text-muted-foreground pl-5">
                                    <span>
                                        {session.updatedAt
                                            ? formatDistanceToNow(session.updatedAt, { addSuffix: true })
                                            : '—'}
                                    </span>
                                </div>
                            </div>
                        ))}

                    {!isLoading && filtered.length === 0 && (
                        <div className="text-center py-10 text-xs text-muted-foreground">
                            {searchQuery ? 'No matching chats.' : 'No saved sessions yet.'}
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
}
