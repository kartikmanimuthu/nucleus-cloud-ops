"use client";

// One chat session's full Mission Control UI: assembles the redesigned leaf
// components (TranscriptHeader, Transcript, RunRail, Composer) over a single
// useChatSession instance. Owns per-session picker state (via useSessionPickers),
// the elapsed timer, hasStarted (skill lock), the right-rail open pref, the
// showWork toggle, composer input/attachments, and the header-menu handlers
// (export/copy/schedule/skill/clear) — all ported from the chat-interface.tsx
// monolith, which this replaces in Task 14.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PanelRight, PanelRightClose } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useChatSession } from "@/lib/agent-chat/use-chat-session";
import { buildChatTranscript } from "@/lib/agent/build-chat-transcript";
import { copyToClipboard, exportToMarkdown, exportToPDF, exportReportToPDF } from "@/lib/chat-export";
import { useDistillSkill } from "@/lib/queries/skills";
import { useDistillScheduledTask } from "@/lib/queries/agent-ops-scheduled-tasks";
import { SCHEDULED_TASK_PREFILL_KEY } from "@/components/agent-ops/scheduled-task-dialog";
import { SkillFormDialog } from "@/components/skills/skill-form-dialog";
import type { FileAttachment } from "@/components/agent/file-upload";
import { Spinner } from "@/components/ui/spinner";
import { Transcript } from "./transcript";
import { EmptyState } from "./empty-state";
import { TranscriptHeader, type TranscriptMenuAction } from "./transcript-header";
import { RunRail } from "@/components/agent/chat/run-rail";
import { Composer } from "./composer";
import { useSessionPickers } from "./use-session-pickers";
import type { SessionStatus } from "./session-sidebar";

// localStorage key for the right run-rail open/closed preference — shared by
// all sessions (ported from chat-interface.tsx:501).
const RAIL_OPEN_STORAGE_KEY = "aiops-rail-open";

export interface SessionViewProps {
  threadId: string;
  ownerUserId?: string;
  active: boolean;
  onStatusChange?: (status: SessionStatus) => void;
  onTitleChange?: (title: string) => void;
}

export function SessionView({ threadId, ownerUserId, active, onStatusChange, onTitleChange }: SessionViewProps) {
  const router = useRouter();

  // hasStarted gates the skill lock (monolith locked the skill picker once a
  // run began). It exists before the hooks below so there's no ordering cycle:
  // the effect that flips it reads useChatSession's messages, which depend on
  // the picker `body` — but `body` is stable, so nothing re-subscribes.
  const [hasStarted, setHasStarted] = useState(false);

  const pickers = useSessionPickers({ threadId, skillLocked: hasStarted });
  const chat = useChatSession({ threadId, ownerUserId, body: pickers.body });

  const { messages, isStreaming, runState, error } = chat;

  // ── Composer input + attachments ────────────────────────────────────────────
  const [inputValue, setInputValue] = useState("");
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);

  // ── Show-work toggle (default off) ──────────────────────────────────────────
  // Collapsed by default: each turn shows just its answer/report, with the
  // process rows (tools/thinking/narration) tucked behind the "Show work (N
  // steps)" button until the user opts in.
  const [showWork, setShowWork] = useState(false);

  // ── Right rail open pref (lg+ only) ─────────────────────────────────────────
  const [railOpen, setRailOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(RAIL_OPEN_STORAGE_KEY);
      if (stored !== null) setRailOpen(stored !== "false");
    } catch {
      // localStorage unavailable — keep default.
    }
  }, []);
  const toggleRail = useCallback(() => {
    setRailOpen((open) => {
      const next = !open;
      try {
        window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, String(next));
      } catch {
        // Preference simply won't persist.
      }
      return next;
    });
  }, []);

  // ── Elapsed timer (ported from AgentExecutionTimer, chat-interface.tsx:548) ──
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (isStreaming) {
      const start = Date.now();
      setElapsedMs(0);
      interval = setInterval(() => setElapsedMs(Date.now() - start), 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isStreaming]);

  // ── hasStarted (skill lock) ─────────────────────────────────────────────────
  useEffect(() => {
    if (messages.length > 0) setHasStarted(true);
  }, [messages.length]);

  // ── Report status + title to the workspace (refs avoid effect re-runs on
  //    every parent re-render passing new inline callbacks). ────────────────────
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  const pendingApproval = runState.pendingApproval;
  const pendingClarifications = runState.pendingClarifications;
  useEffect(() => {
    let status: SessionStatus = "idle";
    if (isStreaming) status = "streaming";
    else if (pendingApproval || pendingClarifications.length > 0) status = "attention";
    onStatusChangeRef.current?.(status);
  }, [isStreaming, pendingApproval, pendingClarifications]);

  // Derive a session title from the first user message — drives both the header
  // and the workspace tab label (sidebar list).
  const [title, setTitle] = useState("New chat");
  useEffect(() => {
    const firstUserMsg = messages.find((m: any) => m.role === "user");
    if (!firstUserMsg) return;
    const text = (firstUserMsg.parts ?? [])
      .filter((p: any) => p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join(" ")
      .trim();
    const derived = text || (typeof firstUserMsg.content === "string" ? firstUserMsg.content : "");
    if (derived) {
      setTitle(derived.slice(0, 60));
      onTitleChangeRef.current?.(derived.slice(0, 50));
    }
  }, [messages]);

  // ── Send ─────────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    if (!inputValue.trim() || isStreaming) return;
    const value = inputValue;
    const files = attachments;
    setInputValue("");
    setAttachments([]);
    setHasStarted(true);
    // AI SDK v7 UIMessages render from `parts` — a bare `content` string
    // produces an EMPTY user bubble (the server still reads `.content`, so
    // both are sent: parts for the UI, content for the /api/chat contract).
    void chat.sendMessage({
      role: "user",
      content: value,
      parts: [
        ...files.map((f) => ({
          type: "file",
          mediaType: f.type,
          filename: f.name,
          url: `data:${f.type};base64,${f.data}`,
        })),
        { type: "text", text: value },
      ],
      experimental_attachments:
        files.length > 0
          ? files.map((f) => ({ name: f.name, contentType: f.type, url: `data:${f.type};base64,${f.data}` }))
          : undefined,
    } as any);
  }, [inputValue, attachments, isStreaming, chat]);

  // ── Enhance prompt (Wand2 in the composer) — ported from the monolith's
  //    handleEnhancePrompt. Rewrites the draft via /api/enhance-prompt. ────────
  const [isEnhancing, setIsEnhancing] = useState(false);
  const handleEnhancePrompt = useCallback(async () => {
    if (!inputValue.trim() || isEnhancing || isStreaming) return;
    setIsEnhancing(true);
    try {
      const res = await fetch("/api/enhance-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: inputValue }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      const data = await res.json();
      if (data.enhancedPrompt) setInputValue(data.enhancedPrompt);
    } catch (e) {
      toast.error("Could not enhance the prompt", {
        description: e instanceof Error ? e.message : "Try again",
      });
    } finally {
      setIsEnhancing(false);
    }
  }, [inputValue, isEnhancing, isStreaming]);

  // ── Header menu actions ──────────────────────────────────────────────────────
  const distillSkill = useDistillSkill();
  const distillScheduledTask = useDistillScheduledTask();
  const [skillDialogOpen, setSkillDialogOpen] = useState(false);
  const [skillDraft, setSkillDraft] = useState<
    { name: string; description: string; tier: string; content: string } | null
  >(null);

  const handleSaveAsSkill = useCallback(async () => {
    if (messages.length === 0) return;
    const transcript = buildChatTranscript(messages as any);
    try {
      const draft = await distillSkill.mutateAsync({ threadId, transcript });
      setSkillDraft(draft);
      setSkillDialogOpen(true);
    } catch (e) {
      toast.error("Could not create skill from chat", {
        description: e instanceof Error ? e.message : "Try again",
      });
    }
  }, [messages, distillSkill, threadId]);

  const handleConvertToScheduledTask = useCallback(async () => {
    if (messages.length === 0) return;
    const transcript = buildChatTranscript(messages as any);
    try {
      const draft = await distillScheduledTask.mutateAsync(transcript);
      sessionStorage.setItem(
        SCHEDULED_TASK_PREFILL_KEY,
        JSON.stringify({ name: draft.name, description: draft.prompt, cronExpression: draft.suggestedCron }),
      );
      router.push("/app/agent-ops/scheduled-tasks?prefill=1");
    } catch (e) {
      toast.error("Could not convert chat to a scheduled task", {
        description: e instanceof Error ? e.message : "Try again",
      });
    }
  }, [messages, distillScheduledTask, router]);

  const handleClear = useCallback(() => {
    chat.clear();
    setHasStarted(false);
    setElapsedMs(null);
  }, [chat]);

  const handleMenuAction = useCallback(
    (action: TranscriptMenuAction) => {
      switch (action) {
        case "export-report":
          void exportReportToPDF(messages as any, threadId).then((ok) => {
            if (!ok) toast.error("No answer to export yet", { description: "Run a task first — this exports the final answer only." });
          });
          break;
        case "export-md":
          void exportToMarkdown(messages as any, threadId);
          break;
        case "export-pdf":
          void exportToPDF(messages as any, threadId).then((ok) => {
            if (!ok) toast.error("PDF export failed");
          });
          break;
        case "copy":
          void copyToClipboard(messages as any).then((ok) =>
            ok ? toast.success("Copied conversation to clipboard") : toast.error("Copy failed"),
          );
          break;
        case "schedule":
          void handleConvertToScheduledTask();
          break;
        case "skill":
          void handleSaveAsSkill();
          break;
        case "clear":
          handleClear();
          break;
      }
    },
    [messages, threadId, handleConvertToScheduledTask, handleSaveAsSkill, handleClear],
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden" data-active={active} data-testid="session-view">
      {/* Header + rail toggle */}
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1">
          <TranscriptHeader
            title={title}
            runState={runState}
            isStreaming={isStreaming}
            elapsedMs={elapsedMs}
            onMenuAction={handleMenuAction}
          />
        </div>
        <button
          type="button"
          onClick={toggleRail}
          aria-label={railOpen ? "Hide run details" : "Show run details"}
          data-testid="rail-toggle"
          className="hidden items-center border-b px-2 text-muted-foreground transition-colors hover:text-foreground lg:flex"
        >
          {railOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRight className="h-4 w-4" />}
        </button>
      </div>

      {/* Middle: transcript + composer column, and the collapsible rail */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {chat.isLoadingHistory && messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner size="sm" label="Loading session" />
            </div>
          ) : messages.length === 0 ? (
            <EmptyState onSuggestion={setInputValue} />
          ) : (
            <Transcript
              messages={messages}
              toolVisibility={chat.toolVisibility}
              decisions={chat.decisions}
              showWork={showWork}
              runState={runState}
              isStreaming={isStreaming}
              onDecide={chat.decide}
              onDecideRemaining={chat.decideRemaining}
              onAnswer={chat.submitClarification}
            />
          )}

          {error && (
            <div
              data-testid="session-error"
              className="w-full px-4 pb-2 text-xs text-destructive md:px-8"
            >
              {error}
            </div>
          )}

          <div className="border-t p-3">
            <div className="w-full px-1 md:px-5">
              <Composer
                value={inputValue}
                onChange={setInputValue}
                onSubmit={handleSubmit}
                onStop={chat.stop}
                isStreaming={isStreaming}
                context={pickers.composerContext}
                attachments={attachments}
                onAttach={setAttachments}
                mode={pickers.agentMode}
                onModeChange={pickers.setAgentMode}
                autoApprove={pickers.autoApprove}
                onAutoApproveChange={pickers.setAutoApprove}
                showTools={showWork}
                onShowToolsChange={setShowWork}
                autoLoadSkills={pickers.autoLoadSkills}
                onAutoLoadSkillsChange={pickers.setAutoLoadSkills}
                onEnhance={handleEnhancePrompt}
                isEnhancing={isEnhancing}
              />
            </div>
          </div>
        </div>

        {/* Right rail — lg+ only; width animates to 0 when closed, the fixed
            inner wrapper keeps content from reflowing mid-transition. */}
        <div
          className={cn(
            "hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out lg:block",
            railOpen ? "w-72 xl:w-80" : "w-0",
          )}
        >
          <div className="h-full w-72 xl:w-80">
            <RunRail runState={runState} isStreaming={isStreaming} context={pickers.railContext} threadId={threadId} />
          </div>
        </div>
      </div>

      <SkillFormDialog
        open={skillDialogOpen}
        onOpenChange={setSkillDialogOpen}
        initialDraft={skillDraft}
        sourceRunId={threadId}
      />
    </div>
  );
}
