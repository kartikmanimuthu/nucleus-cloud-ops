'use client';

import { useState } from 'react';
import { ChatInterface } from '@/components/agent/chat-interface';

export default function AgentPage() {
    const [threadId, setThreadId] = useState(() => Date.now().toString());

    const handleThreadSelect = (id: string) => {
        setThreadId(id);
    };

    const handleNewChat = () => {
        setThreadId(Date.now().toString());
    };

    return (
        <div className="flex h-[calc(100vh-theme(spacing.16))] overflow-hidden bg-background">
            <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative p-4">
                <ChatInterface 
                    key={threadId} 
                    threadId={threadId} 
                    onThreadSelect={handleThreadSelect}
                    onNewChat={handleNewChat}
                />
            </main>
        </div>
    );
}
