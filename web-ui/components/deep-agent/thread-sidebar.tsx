'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  Plus,
  MessageSquare,
  Trash2,
  Search,
  Brain,
} from 'lucide-react';
import type { DeepAgentThread } from '@/lib/deep-agent/types';

type ThreadStub = Omit<DeepAgentThread, 'messages'>;

interface ThreadSidebarProps {
  threads: ThreadStub[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onDeleteThread: (id: string) => void;
}

export function ThreadSidebar({
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread,
}: ThreadSidebarProps) {
  const [search, setSearch] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const filtered = threads.filter(t =>
    t.title.toLowerCase().includes(search.toLowerCase()),
  );

  function formatDate(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);

    if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  return (
    <div className="w-60 shrink-0 border-r border-border bg-card flex flex-col">
      {/* Header */}
      <div className="px-4 py-4 border-b border-border space-y-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
            <Brain className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-xs font-bold text-foreground tracking-wide uppercase">Deep Agent</span>
        </div>

        <button
          onClick={onNewThread}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300 border border-violet-500/20 text-xs font-medium hover:bg-violet-500/20 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          New Conversation
        </button>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search threads…"
            className="w-full pl-7 pr-3 py-1.5 bg-muted border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-violet-500/50 transition-colors"
          />
        </div>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto py-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-muted-foreground">
            <MessageSquare className="w-6 h-6 opacity-40" />
            <p className="text-xs">No conversations yet</p>
          </div>
        ) : (
          <div className="px-2 space-y-0.5">
            {filtered.map(thread => (
              <div
                key={thread.threadId}
                className="relative group"
                onMouseEnter={() => setHoveredId(thread.threadId)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <button
                  onClick={() => onSelectThread(thread.threadId)}
                  className={cn(
                    'w-full flex items-start gap-2.5 px-3 py-2.5 rounded-xl text-left transition-all border',
                    activeThreadId === thread.threadId
                      ? 'bg-violet-500/10 border-violet-500/20'
                      : 'hover:bg-accent border-transparent',
                  )}
                >
                  <MessageSquare
                    className={cn(
                      'w-3.5 h-3.5 shrink-0 mt-0.5',
                      activeThreadId === thread.threadId ? 'text-violet-500 dark:text-violet-400' : 'text-muted-foreground',
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <p
                      className={cn(
                        'text-xs font-medium truncate leading-snug',
                        activeThreadId === thread.threadId ? 'text-violet-700 dark:text-white' : 'text-foreground',
                      )}
                    >
                      {thread.title}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {formatDate(thread.updatedAt)}
                    </p>
                  </div>
                </button>

                {/* Delete button (hover only) */}
                {hoveredId === thread.threadId && activeThreadId !== thread.threadId && (
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      onDeleteThread(thread.threadId);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer info */}
      <div className="px-4 py-3 border-t border-border">
        <p className="text-[10px] text-muted-foreground text-center">
          {threads.length} conversation{threads.length !== 1 ? 's' : ''} stored
        </p>
      </div>
    </div>
  );
}
