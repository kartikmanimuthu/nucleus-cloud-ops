'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Plus, Search, Trash2, PanelLeft, PanelLeftClose } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useThreads, useDeleteThread, type Thread } from '@/lib/queries/threads';

export type SessionStatus = 'streaming' | 'attention' | 'idle';

export interface SessionSidebarProps {
  activeId: string;
  onSelect: (threadId: string, ownerUserId?: string) => void;
  onNew: () => void;
  statuses: Map<string, SessionStatus>;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

interface SessionGroup {
  label: string;
  items: Thread[];
}

function groupSessions(threads: Thread[]): SessionGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

  const today: Thread[] = [];
  const yesterday: Thread[] = [];
  const previous: Thread[] = [];

  for (const thread of threads) {
    const updatedAt = thread.updatedAt ?? 0;
    if (updatedAt >= startOfToday) today.push(thread);
    else if (updatedAt >= startOfYesterday) yesterday.push(thread);
    else previous.push(thread);
  }

  return [
    { label: 'Today', items: today },
    { label: 'Yesterday', items: yesterday },
    { label: 'Previous', items: previous },
  ].filter((group) => group.items.length > 0);
}

function StatusDot({ status }: { status?: SessionStatus }) {
  if (status === 'streaming') {
    return <span data-testid="status-streaming" className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 animate-pulse" />;
  }
  if (status === 'attention') {
    return <span data-testid="status-attention" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />;
  }
  return null;
}

export function SessionSidebar({
  activeId,
  onSelect,
  onNew,
  statuses,
  collapsed,
  onToggleCollapse,
}: SessionSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const { data: threads = [], isLoading } = useThreads();
  const deleteThread = useDeleteThread();

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteThread.mutate(id, {
      onSuccess: () => {
        if (activeId === id) onNew();
      },
      onError: (err: unknown) => console.error('Failed to delete thread', err),
    });
  };

  if (collapsed) {
    return (
      <div className="w-12 border-r bg-muted/20 flex flex-col items-center gap-2 py-3">
        <Button variant="ghost" size="icon" onClick={onNew} aria-label="New chat">
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          aria-label="Expand sidebar"
          data-testid="sidebar-collapse-toggle"
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  const filtered = threads.filter((t) => t.title.toLowerCase().includes(searchQuery.toLowerCase()));
  const groups = groupSessions(filtered);

  return (
    <div className="w-64 border-r bg-muted/20 flex flex-col">
      <div className="p-3 border-b space-y-2">
        <div className="flex items-center gap-1">
          <Button onClick={onNew} className="w-full justify-start gap-2">
            <Plus className="h-4 w-4" />
            New chat
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleCollapse}
            aria-label="Collapse sidebar"
            data-testid="sidebar-collapse-toggle"
            className="shrink-0"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-xs"
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-3">
          {isLoading && (
            <div className="py-8 text-center text-xs text-muted-foreground">Loading sessions...</div>
          )}

          {!isLoading && groups.length === 0 && (
            <div className="py-8 text-center text-xs text-muted-foreground">No sessions found.</div>
          )}

          {!isLoading &&
            groups.map((group) => (
              <div key={group.label} className="space-y-1">
                <div className="px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
                {group.items.map((thread) => {
                  const status = statuses.get(thread.id);
                  const isActive = thread.id === activeId;
                  return (
                    <div
                      key={thread.id}
                      data-testid="session-row"
                      onClick={() => onSelect(thread.id, thread.ownerUserId)}
                      className={cn(
                        'group flex items-center gap-2 rounded-md px-2 py-2 text-sm cursor-pointer transition-colors hover:bg-muted/60',
                        isActive && 'bg-muted'
                      )}
                    >
                      <StatusDot status={status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate leading-tight">{thread.title || 'Untitled session'}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {thread.updatedAt ? formatDistanceToNow(thread.updatedAt, { addSuffix: true }) : '—'}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => handleDelete(e, thread.id)}
                        aria-label="Delete session"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            ))}
        </div>
      </ScrollArea>
    </div>
  );
}
