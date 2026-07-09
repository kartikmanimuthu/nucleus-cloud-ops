'use client';

import { useCallback, useState } from 'react';
import { ChatInterface } from '@/components/agent/chat-interface';
import { ChatTabBar, ChatTab } from '@/components/agent/chat-tab-bar';
import { cn } from '@/lib/utils';

const MAX_TABS = 8;

function makeTab(threadId?: string): ChatTab {
  return {
    threadId: threadId ?? Date.now().toString(),
    title: 'New Chat',
    status: 'idle',
  };
}

export default function AgentPage() {
  const [tabs, setTabs] = useState<ChatTab[]>(() => [makeTab()]);
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0].threadId);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ── Tab management ─────────────────────────────────────────────────────────

  const handleNewChat = useCallback(() => {
    setTabs((prev) => {
      if (prev.length >= MAX_TABS) return prev;
      const tab = makeTab();
      setActiveTabId(tab.threadId);
      return [...prev, tab];
    });
  }, []);

  const handleCloseTab = useCallback((threadId: string) => {
    setTabs((prev) => {
      if (prev.length === 1) {
        // Last tab: reset it to a blank chat instead of removing
        const fresh = makeTab();
        setActiveTabId(fresh.threadId);
        return [fresh];
      }
      const idx = prev.findIndex((t) => t.threadId === threadId);
      const next = prev.filter((t) => t.threadId !== threadId);
      // If closing the active tab, switch to the nearest neighbour
      if (threadId === activeTabId) {
        const newActive = next[Math.min(idx, next.length - 1)];
        setActiveTabId(newActive.threadId);
      }
      return next;
    });
  }, [activeTabId]);

  /** Called from ThreadSidebar inside a ChatInterface's history popover */
  const handleThreadSelect = useCallback((threadId: string, ownerUserId?: string) => {
    setTabs((prev) => {
      // Already open? Just switch to it
      const existing = prev.find((t) => t.threadId === threadId);
      if (existing) {
        setActiveTabId(threadId);
        return prev;
      }
      // If at limit, replace the current active tab (which the user navigated from)
      if (prev.length >= MAX_TABS) {
        const updated = prev.map((t) =>
          t.threadId === activeTabId
            ? { ...makeTab(threadId), title: 'Loading...', ownerUserId }
            : t,
        );
        setActiveTabId(threadId);
        return updated;
      }
      // Open in a new tab
      const tab: ChatTab = { ...makeTab(threadId), title: 'Loading...', ownerUserId };
      setActiveTabId(threadId);
      return [...prev, tab];
    });
  }, [activeTabId]);

  // ── Per-tab status / title updates from ChatInterface ─────────────────────

  const handleStatusChange = useCallback(
    (threadId: string, status: ChatTab['status']) => {
      setTabs((prev) =>
        prev.map((t) => (t.threadId === threadId ? { ...t, status } : t)),
      );
    },
    [],
  );

  const handleTitleChange = useCallback((threadId: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.threadId === threadId && t.title === 'New Chat'
          ? { ...t, title }
          : t,
      ),
    );
  }, []);

  // ──────────────────────────────────────────────────────────────────────────

  // Each tab's ChatInterface is mounted EXACTLY ONCE and never conditionally
  // duplicated — fullscreen is a pure layout toggle on the single outer wrapper
  // (same DOM node, only its className changes), so every ChatInterface keeps
  // its component identity and its useChat({ id }) state across the toggle. An
  // in-progress stream is preserved when entering/exiting fullscreen; history is
  // fetched once per thread rather than twice.
  return (
    <div
      className={cn(
        isFullscreen
          ? 'fixed inset-0 z-50 flex flex-col bg-background'
          : 'flex flex-col h-[calc(100vh-theme(spacing.16))] overflow-hidden bg-background',
      )}
    >
      <ChatTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabSelect={setActiveTabId}
        onTabClose={handleCloseTab}
        onNewChat={handleNewChat}
        onThreadSelect={handleThreadSelect}
        maxTabs={MAX_TABS}
      />

      <div className="flex-1 relative overflow-hidden p-4">
        {tabs.map((tab) => (
          <div
            key={tab.threadId}
            className="absolute inset-4"
            style={{ display: tab.threadId === activeTabId ? 'flex' : 'none' }}
          >
            <ChatInterface
              threadId={tab.threadId}
              ownerUserId={tab.ownerUserId}
              isFullscreen={isFullscreen}
              onToggleFullscreen={() => setIsFullscreen((prev) => !prev)}
              onStatusChange={(s) => handleStatusChange(tab.threadId, s)}
              onTitleChange={(title) => handleTitleChange(tab.threadId, title)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
