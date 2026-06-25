'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  ListTodo,
  Plus,
  Check,
  Clock,
  Loader2,
  AlertTriangle,
  Trash2,
} from 'lucide-react';
import type { TodoItem, TodoStatus } from '@/lib/deep-agent/types';

const STATUS_CONFIG: Record<TodoStatus, { icon: typeof Check; color: string; label: string }> = {
  pending:     { icon: Clock,          color: 'text-muted-foreground',   label: 'Pending' },
  in_progress: { icon: Loader2,        color: 'text-amber-500',          label: 'In Progress' },
  done:        { icon: Check,          color: 'text-emerald-500',        label: 'Done' },
  blocked:     { icon: AlertTriangle,  color: 'text-rose-500',           label: 'Blocked' },
};

const STATUS_RING: Record<TodoStatus, string> = {
  pending:     'border-border',
  in_progress: 'border-amber-500',
  done:        'border-emerald-500 bg-emerald-500/15',
  blocked:     'border-rose-500',
};

interface TodoPanelProps {
  todos: TodoItem[];
  threadId: string | null;
  onTodosChange: (todos: TodoItem[]) => void;
}

export function TodoPanel({ todos, threadId, onTodosChange }: TodoPanelProps) {
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);

  const counts = {
    total: todos.length,
    done: todos.filter(t => t.status === 'done').length,
    inProgress: todos.filter(t => t.status === 'in_progress').length,
    blocked: todos.filter(t => t.status === 'blocked').length,
  };

  async function addTodo() {
    if (!newTitle.trim() || !threadId) return;
    try {
      const res = await fetch('/api/deep-agent/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, title: newTitle.trim() }),
      });
      if (res.ok) {
        const { todo } = await res.json();
        onTodosChange([...todos, todo]);
        setNewTitle('');
        setAdding(false);
      }
    } catch (e) {
      console.error('Failed to add todo:', e);
    }
  }

  async function updateStatus(todoId: string, status: TodoStatus) {
    if (!threadId) return;
    try {
      const res = await fetch('/api/deep-agent/todos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, todoId, updates: { status } }),
      });
      if (res.ok) {
        const { todos: updated } = await res.json();
        onTodosChange(updated);
      }
    } catch (e) {
      console.error('Failed to update todo:', e);
    }
  }

  async function deleteTodo(todoId: string) {
    if (!threadId) return;
    try {
      const res = await fetch('/api/deep-agent/todos', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, todoId }),
      });
      if (res.ok) {
        const { todos: updated } = await res.json();
        onTodosChange(updated);
      }
    } catch (e) {
      console.error('Failed to delete todo:', e);
    }
  }

  // Sort: in_progress first, then pending, then done, then blocked
  const sorted = [...todos].sort((a, b) => {
    const order: Record<TodoStatus, number> = { in_progress: 0, pending: 1, done: 2, blocked: 3 };
    return order[a.status] - order[b.status];
  });

  const progressPct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;

  return (
    <div className="w-72 shrink-0 border-l border-border bg-card flex flex-col">
      {/* Header */}
      <div className="px-4 py-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-amber-500/15 flex items-center justify-center">
              <ListTodo className="w-3.5 h-3.5 text-amber-500" />
            </div>
            <span className="text-sm font-semibold text-foreground">To-Do List</span>
          </div>
          <button
            onClick={() => setAdding(v => !v)}
            className={cn(
              'w-6 h-6 rounded-md flex items-center justify-center transition-all',
              adding
                ? 'bg-amber-500/20 text-amber-500'
                : 'bg-muted text-muted-foreground hover:bg-amber-500/15 hover:text-amber-500',
            )}
            title="Add todo"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Progress summary */}
        {counts.total > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1.5">
              <span>{counts.done}/{counts.total} completed</span>
              <div className="flex items-center gap-2">
                {counts.inProgress > 0 && (
                  <span className="text-amber-500 font-medium">{counts.inProgress} running</span>
                )}
                {counts.blocked > 0 && (
                  <span className="text-rose-500 font-medium">{counts.blocked} blocked</span>
                )}
              </div>
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">{progressPct}%</p>
          </div>
        )}
      </div>

      {/* Add input */}
      {adding && (
        <div className="px-4 py-3 border-b border-border bg-amber-500/5">
          <input
            autoFocus
            type="text"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') addTodo();
              if (e.key === 'Escape') { setAdding(false); setNewTitle(''); }
            }}
            placeholder="New task…"
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <div className="flex gap-2 mt-2.5">
            <button
              onClick={addTodo}
              className="flex-1 py-1.5 rounded-lg bg-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-medium hover:bg-amber-500/30 transition-colors border border-amber-500/20"
            >
              Add Task
            </button>
            <button
              onClick={() => { setAdding(false); setNewTitle(''); }}
              className="px-3 py-1.5 rounded-lg bg-muted text-muted-foreground text-xs hover:bg-accent transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Todo list */}
      <div className="flex-1 overflow-y-auto py-2">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground text-xs text-center px-6 gap-2">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
              <ListTodo className="w-5 h-5 opacity-50" />
            </div>
            <p className="leading-relaxed">The agent will create tasks here as it plans</p>
          </div>
        ) : (
          <div className="px-3 space-y-1">
            {sorted.map(todo => {
              const { icon: Icon, color, label } = STATUS_CONFIG[todo.status];
              return (
                <div
                  key={todo.id}
                  className="group flex items-start gap-2.5 px-3 py-2.5 rounded-xl hover:bg-accent transition-colors"
                >
                  {/* Status click-cycle */}
                  <button
                    onClick={() => {
                      const cycle: Record<TodoStatus, TodoStatus> = {
                        pending: 'in_progress',
                        in_progress: 'done',
                        done: 'pending',
                        blocked: 'pending',
                      };
                      updateStatus(todo.id, cycle[todo.status]);
                    }}
                    className={cn(
                      'w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 transition-all hover:scale-110',
                      STATUS_RING[todo.status],
                    )}
                    title={`Status: ${label} — click to cycle`}
                  >
                    {todo.status === 'done' && <Check className="w-2.5 h-2.5 text-emerald-500" />}
                    {todo.status === 'in_progress' && <Loader2 className="w-2 h-2 text-amber-500 animate-spin" />}
                    {todo.status === 'blocked' && <AlertTriangle className="w-2 h-2 text-rose-500" />}
                  </button>

                  <div className="flex-1 min-w-0">
                    <p
                      className={cn(
                        'text-xs leading-snug',
                        todo.status === 'done'
                          ? 'line-through text-muted-foreground'
                          : 'text-foreground',
                      )}
                    >
                      {todo.title}
                    </p>
                    <span className={cn('text-[10px] font-medium', color)}>{label}</span>
                  </div>

                  <button
                    onClick={() => deleteTodo(todo.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
