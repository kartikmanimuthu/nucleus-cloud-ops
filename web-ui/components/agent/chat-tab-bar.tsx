"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Plus, X, History } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ThreadSidebar } from "@/components/agent/thread-sidebar";

export interface ChatTab {
  threadId: string;
  title: string;
  status: "idle" | "streaming" | "error";
}

interface ChatTabBarProps {
  tabs: ChatTab[];
  activeTabId: string;
  onTabSelect: (threadId: string) => void;
  onTabClose: (threadId: string) => void;
  onNewChat: () => void;
  onThreadSelect: (threadId: string) => void;
  maxTabs?: number;
}

export function ChatTabBar({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  onNewChat,
  onThreadSelect,
  maxTabs = 8,
}: ChatTabBarProps) {
  const isAtLimit = tabs.length >= maxTabs;
  const openTabIds = tabs.map((t) => t.threadId);

  return (
    <div className="flex items-center border-b bg-muted/20 h-10 px-1 gap-0 overflow-x-auto shrink-0 scrollbar-none">
      {tabs.map((tab) => {
        const isActive = tab.threadId === activeTabId;
        return (
          <div
            key={tab.threadId}
            className={cn(
              "group flex items-center gap-1.5 px-3 h-full text-xs cursor-pointer select-none shrink-0 border-b-2 transition-colors min-w-0 max-w-[180px]",
              isActive
                ? "border-primary bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40",
            )}
            onClick={() => onTabSelect(tab.threadId)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onTabClose(tab.threadId);
              }
            }}
          >
            {/* Status dot */}
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full shrink-0",
                tab.status === "streaming" && "bg-blue-500 animate-pulse",
                tab.status === "error" && "bg-destructive",
                tab.status === "idle" &&
                  (isActive ? "bg-primary/60" : "bg-muted-foreground/40"),
              )}
            />

            {/* Title */}
            <span className="truncate flex-1 min-w-0 font-medium">
              {tab.title || "New Chat"}
            </span>

            {/* Close button */}
            <button
              className={cn(
                "shrink-0 rounded-sm p-0.5 transition-opacity hover:bg-muted",
                "opacity-0 group-hover:opacity-100",
                isActive && "opacity-60",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.threadId);
              }}
              title="Close tab"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}

      {/* Divider */}
      <div className="w-px h-4 bg-border mx-1 shrink-0" />

      {/* History button */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            title="Chat history"
          >
            <History className="w-4 h-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          className="w-[320px] p-0 h-[600px] flex flex-col overflow-hidden"
        >
          <ThreadSidebar
            currentThreadId={activeTabId}
            openTabIds={openTabIds}
            onThreadSelect={onThreadSelect}
            onNewChat={onNewChat}
            className="border-none bg-background rounded-md w-full h-full"
          />
        </PopoverContent>
      </Popover>

      {/* New chat button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={onNewChat}
        disabled={isAtLimit}
        title={isAtLimit ? `Max ${maxTabs} chats open` : "New Chat"}
      >
        <Plus className="w-4 h-4" />
      </Button>

      {/* Streaming badge */}
      {tabs.filter((t) => t.status === "streaming").length > 0 && (
        <span className="ml-auto mr-2 text-[10px] text-blue-500 shrink-0 tabular-nums">
          {tabs.filter((t) => t.status === "streaming").length} streaming
        </span>
      )}
    </div>
  );
}
