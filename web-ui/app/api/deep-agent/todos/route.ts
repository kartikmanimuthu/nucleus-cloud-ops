// ============================================================================
// Deep Agent Module — Todos API
// GET    /api/deep-agent/todos?threadId=xxx → list todos for a thread
// PATCH  /api/deep-agent/todos              → update a todo item
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import {
    getThread,
    upsertTodos,
} from '../../../../lib/deep-agent/db/chat-history-store';
import type { TodoItem, TodoStatus } from '../../../../lib/deep-agent/types';

export async function GET(req: NextRequest) {
    const threadId = new URL(req.url).searchParams.get('threadId');
    if (!threadId) {
        return NextResponse.json({ error: 'threadId is required' }, { status: 400 });
    }
    try {
        const thread = await getThread(threadId);
        if (!thread) {
            return NextResponse.json({ todos: [] });
        }
        return NextResponse.json({ todos: thread.todos ?? [] });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const { threadId, title, status = 'pending' } = await req.json();
        if (!threadId || !title) {
            return NextResponse.json({ error: 'threadId and title are required' }, { status: 400 });
        }

        const thread = await getThread(threadId);
        const existing: TodoItem[] = thread?.todos ?? [];
        const now = new Date().toISOString();
        const newTodo: TodoItem = {
            id: uuidv4(),
            title,
            status: status as TodoStatus,
            createdAt: now,
            updatedAt: now,
        };
        await upsertTodos(threadId, [...existing, newTodo]);
        return NextResponse.json({ todo: newTodo }, { status: 201 });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    try {
        const { threadId, todoId, updates } = await req.json();
        if (!threadId || !todoId) {
            return NextResponse.json({ error: 'threadId and todoId are required' }, { status: 400 });
        }

        const thread = await getThread(threadId);
        if (!thread) {
            return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
        }

        const todos = (thread.todos ?? []).map(t =>
            t.id === todoId ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t,
        );
        await upsertTodos(threadId, todos);
        return NextResponse.json({ todos });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    const { threadId, todoId } = await req.json();
    if (!threadId || !todoId) {
        return NextResponse.json({ error: 'threadId and todoId are required' }, { status: 400 });
    }
    try {
        const thread = await getThread(threadId);
        if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });

        const todos = (thread.todos ?? []).filter(t => t.id !== todoId);
        await upsertTodos(threadId, todos);
        return NextResponse.json({ todos });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
