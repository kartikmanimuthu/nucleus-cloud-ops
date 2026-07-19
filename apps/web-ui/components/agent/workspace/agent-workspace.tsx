"use client";

// The AI Ops workspace shell: owns the multi-session state (ported from the
// legacy tabs page.tsx, with the ChatTabBar replaced by SessionSidebar) and
// mounts one SessionView per open session. Background sessions stay MOUNTED and
// hidden via `display:none` (never unmounted) so in-progress streams and
// useChatSession state survive switching — exactly the invariant the tab
// implementation preserved.

import { useCallback, useState } from "react";
import { Menu, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SessionSidebar, type SessionStatus } from "./session-sidebar";
import { SessionView } from "./session-view";

const MAX_OPEN = 8;

interface OpenSession {
  threadId: string;
  ownerUserId?: string;
}

function makeSession(): OpenSession {
  return { threadId: Date.now().toString() };
}

/**
 * Add a session to the open set, capping at MAX_OPEN. When over the cap, evict
 * the oldest session that is neither the just-opened one nor currently
 * streaming — so an in-progress background run is never torn down (and thus
 * never loses its stream) just because a new session was opened.
 */
function addOpenSession(
  prev: OpenSession[],
  entry: OpenSession,
  statuses: Map<string, SessionStatus>,
): OpenSession[] {
  if (prev.some((s) => s.threadId === entry.threadId)) return prev;
  const next = [...prev, entry];
  while (next.length > MAX_OPEN) {
    const idx = next.findIndex(
      (s) => s.threadId !== entry.threadId && statuses.get(s.threadId) !== "streaming",
    );
    if (idx === -1) break; // everything else is streaming — keep them all
    next.splice(idx, 1);
  }
  return next;
}

export function AgentWorkspace() {
  const [openSessions, setOpenSessions] = useState<OpenSession[]>(() => [makeSession()]);
  const [activeId, setActiveId] = useState<string>(openSessions[0].threadId);
  const [statuses, setStatuses] = useState<Map<string, SessionStatus>>(new Map());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const handleNew = useCallback(() => {
    const session = makeSession();
    setOpenSessions((prev) => addOpenSession(prev, session, statuses));
    setActiveId(session.threadId);
  }, [statuses]);

  const handleSelect = useCallback(
    (threadId: string, ownerUserId?: string) => {
      setOpenSessions((prev) => addOpenSession(prev, { threadId, ownerUserId }, statuses));
      setActiveId(threadId);
    },
    [statuses],
  );

  const handleStatusChange = useCallback((threadId: string, status: SessionStatus) => {
    setStatuses((prev) => {
      if (prev.get(threadId) === status) return prev;
      const next = new Map(prev);
      next.set(threadId, status);
      return next;
    });
  }, []);

  return (
    <div className="flex h-[calc(100vh-theme(spacing.16))] overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex">
        <SessionSidebar
          activeId={activeId}
          onSelect={handleSelect}
          onNew={handleNew}
          statuses={statuses}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
          pendingSessions={openSessions.map((s) => s.threadId)}
        />
      </div>

      {/* Mobile sidebar as a Sheet drawer */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Chat sessions</SheetTitle>
          </SheetHeader>
          <SessionSidebar
            activeId={activeId}
            onSelect={(threadId, ownerUserId) => {
              handleSelect(threadId, ownerUserId);
              setMobileSidebarOpen(false);
            }}
            onNew={() => {
              handleNew();
              setMobileSidebarOpen(false);
            }}
            statuses={statuses}
            collapsed={false}
            onToggleCollapse={() => setMobileSidebarOpen(false)}
            pendingSessions={openSessions.map((s) => s.threadId)}
          />
        </SheetContent>
      </Sheet>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex items-center gap-1 border-b px-2 py-1.5 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileSidebarOpen(true)}
            aria-label="Open sessions"
          >
            <Menu className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleNew} className="gap-1.5">
            <Plus className="h-4 w-4" />
            New chat
          </Button>
        </div>

        {/* Sessions — mounted once each, hidden (not unmounted) when inactive */}
        <div className="relative min-h-0 flex-1">
          {openSessions.map((session) => {
            const isActive = session.threadId === activeId;
            return (
              <div
                key={session.threadId}
                className="absolute inset-0"
                style={{ display: isActive ? "flex" : "none" }}
              >
                <SessionView
                  threadId={session.threadId}
                  ownerUserId={session.ownerUserId}
                  active={isActive}
                  onStatusChange={(status) => handleStatusChange(session.threadId, status)}
                  onTitleChange={() => {}}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
