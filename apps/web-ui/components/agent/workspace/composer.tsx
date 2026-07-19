"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Send, Settings2, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FileUpload, type FileAttachment } from "@/components/agent/file-upload";
import { AccountChip, KbSection, ModelChip, SkillChip, ToolsSection, type ComposerContext } from "./composer-pickers";

export type { ComposerContext } from "./composer-pickers";

const MAX_CHARS = 2000;
const CHAR_WARNING_THRESHOLD = 1800;
const TEXTAREA_MAX_HEIGHT_PX = 192; // matches max-h-48

// Must stay in sync with the modes /api/chat accepts (fast | plan | deep) —
// same vocabulary as the monolith's AGENT_MODES (chat-interface.tsx).
const AGENT_MODES = [
  { id: "fast", label: "Fast" },
  { id: "plan", label: "Plan & execute" },
  { id: "deep", label: "Deep" },
];

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  context: ComposerContext;
  attachments: FileAttachment[];
  onAttach: (files: FileAttachment[]) => void;
  mode: string;
  onModeChange: (mode: string) => void;
  autoApprove: boolean;
  onAutoApproveChange: (value: boolean) => void;
  showTools: boolean;
  onShowToolsChange: (value: boolean) => void;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  disabled,
  context,
  attachments,
  onAttach,
  mode,
  onModeChange,
  autoApprove,
  onAutoApproveChange,
  showTools,
  onShowToolsChange,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [modePopoverOpen, setModePopoverOpen] = useState(false);
  const [plusPopoverOpen, setPlusPopoverOpen] = useState(false);

  // Auto-grow 1→8 rows; capped by max-h-48 (192px) after which the textarea
  // scrolls internally instead of growing further.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [value]);

  const isEmpty = !value.trim();
  const canSubmit = !isEmpty && !disabled && !isStreaming;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits; Shift+Enter inserts a newline; an in-progress IME
    // composition (e.g. Japanese/Chinese input) must not be hijacked as submit.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSubmit) onSubmit();
    }
  };

  const modeLabel = AGENT_MODES.find((m) => m.id === mode)?.label ?? "Mode";
  const kbCount = context.kb.selectedIds.length;
  const toolsCount = context.tools.selectedIds.length;

  return (
    <div className="rounded-xl border bg-card shadow-sm transition-all focus-within:ring-1 focus-within:ring-ring">
      {/* Chips row — account/model/skill, removable */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5">
        <AccountChip field={context.accounts} disabled={disabled} />
        <ModelChip field={context.model} disabled={disabled} />
        <SkillChip field={context.skill} disabled={disabled} />
      </div>

      {/* Textarea */}
      <div className="px-3 pt-1.5">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask the agent to plan, execute, reflect, and revise..."
          disabled={disabled}
          data-testid="composer-input"
          rows={1}
          maxLength={MAX_CHARS}
          className="min-h-[40px] max-h-48 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-xs focus-visible:ring-0"
        />
      </div>

      {/* Footer: + popover (KB/tools/attach), char counter, mode, send/stop */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Popover open={plusPopoverOpen} onOpenChange={setPlusPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                aria-label="Add knowledge, tools, or attachments"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-72 space-y-3 p-3">
              <KbSection field={context.kb} disabled={disabled} />
              <ToolsSection field={context.tools} disabled={disabled} />
              <div className="space-y-1.5 border-t pt-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Attach images
                </p>
                <FileUpload files={attachments} onFilesChange={onAttach} disabled={disabled} />
              </div>
            </PopoverContent>
          </Popover>

          {(kbCount > 0 || toolsCount > 0) && (
            <span className="text-[10px] text-muted-foreground">
              {[kbCount > 0 ? `${kbCount} KB` : null, toolsCount > 0 ? `${toolsCount} tools` : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {value.length > CHAR_WARNING_THRESHOLD && (
            <span data-testid="char-counter" className="text-xs text-muted-foreground tabular-nums">
              {value.length}/{MAX_CHARS}
            </span>
          )}

          <Popover open={modePopoverOpen} onOpenChange={setModePopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <Settings2 className="h-3 w-3" />
                {modeLabel}
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="w-64 space-y-3 p-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Mode</Label>
                <Select value={mode} onValueChange={onModeChange} disabled={disabled}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Mode" />
                  </SelectTrigger>
                  <SelectContent>
                    {AGENT_MODES.map((m) => (
                      <SelectItem key={m.id} value={m.id} className="text-xs">
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label
                  htmlFor="composer-auto-approve"
                  className="text-xs font-normal text-muted-foreground"
                  title="Read-only tools run without asking. Destructive actions always pause for approval."
                >
                  Auto-approve read-only tools
                </Label>
                <Switch
                  id="composer-auto-approve"
                  checked={autoApprove}
                  onCheckedChange={onAutoApproveChange}
                  disabled={disabled}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="composer-show-tools" className="text-xs font-normal text-muted-foreground">
                  Show work
                </Label>
                <Switch
                  id="composer-show-tools"
                  checked={showTools}
                  onCheckedChange={onShowToolsChange}
                  disabled={disabled}
                />
              </div>
            </PopoverContent>
          </Popover>

          <Button
            type="button"
            size="icon"
            data-testid="composer-send-button"
            onClick={isStreaming ? onStop : onSubmit}
            disabled={isStreaming ? false : !canSubmit}
            aria-label={isStreaming ? "Stop" : "Send"}
            className={cn(
              "h-8 w-8 shrink-0 rounded-full transition-all",
              isStreaming
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-primary hover:bg-primary/90",
            )}
          >
            {isStreaming ? <Square className="h-3.5 w-3.5" /> : <Send className="ml-0.5 h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
