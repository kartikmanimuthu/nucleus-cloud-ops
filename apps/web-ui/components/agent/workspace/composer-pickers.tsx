"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Composer's picker option/field shapes — ported 1:1 from the monolith's local
// state (chat-interface.tsx: accounts/availableModels/availableSkills/
// knowledgeBases/mcpServers), trimmed to what the UI actually reads. The shell
// (Task 13) owns fetching; Composer is purely presentational over these.
//
// Every field carries its own optional `disabled` so the shell can express
// per-picker locks (e.g. the monolith locks the skill picker once a run has
// started — chat-interface.tsx:2295 `hasStarted || isLoading` — while account
// and model stay changeable, chat-interface.tsx:2057/2201). A field's
// `disabled` ORs with Composer's top-level `disabled` prop; either one locks
// that specific chip/section.

export interface ComposerAccountOption {
  accountId: string;
  name: string;
}

export interface ComposerModelOption {
  id: string;
  label: string;
  provider: string;
}

export interface ComposerSkillOption {
  id: string;
  name: string;
  description: string;
}

export interface ComposerKbOption {
  id: string;
  name: string;
}

export interface ComposerToolOption {
  id: string;
  name: string;
  description: string;
}

export interface ComposerAccountsField {
  available: ComposerAccountOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  loading?: boolean;
  disabled?: boolean;
  /**
   * Set when the caller lacks `read Account`, so the chip can say so instead of
   * reading as "this tenant has no accounts". An empty list and a forbidden list
   * look identical otherwise, and the difference is the one thing the user needs.
   *
   * The same field appears on the skill and tools pickers, for the same reason —
   * each of those lists has its own permission behind it (`read Skill`,
   * `read AIOps`) and a role can hold one without the others.
   */
  denied?: string | null;
}

export interface ComposerModelField {
  available: ComposerModelOption[];
  selectedId: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export interface ComposerSkillField {
  available: ComposerSkillOption[];
  selectedId: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  /** Set when the caller lacks `read Skill` — see ComposerAccountsField.denied. */
  denied?: string | null;
}

export interface ComposerKbField {
  available: ComposerKbOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

export interface ComposerToolsField {
  available: ComposerToolOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  loading?: boolean;
  disabled?: boolean;
  /** Set when the caller lacks `read AIOps` — see ComposerAccountsField.denied. */
  denied?: string | null;
}

export interface ComposerContext {
  accounts: ComposerAccountsField;
  model: ComposerModelField;
  skill: ComposerSkillField;
  kb: ComposerKbField;
  tools: ComposerToolsField;
}

// Provider display order/labels — mirrors the monolith's model-grouping
// (chat-interface.tsx:2227-2251): Bedrock first, then the rest in a stable
// order, with any unrecognised provider key falling back to itself.
const PROVIDER_GROUP_LABELS: Record<string, string> = {
  bedrock: "Bedrock",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
  vllm: "vLLM",
  lmstudio: "LM Studio",
  litellm: "LiteLLM Gateway",
  "openai-compatible": "Self-Hosted",
};
const PROVIDER_GROUP_ORDER = Object.keys(PROVIDER_GROUP_LABELS);

function groupModelsByProvider(models: ComposerModelOption[]) {
  const present = Array.from(new Set(models.map((m) => m.provider)));
  const orderedProviders = [
    ...PROVIDER_GROUP_ORDER.filter((p) => present.includes(p)),
    ...present.filter((p) => !PROVIDER_GROUP_ORDER.includes(p)),
  ];
  return orderedProviders
    .map((provider) => ({
      provider,
      label: PROVIDER_GROUP_LABELS[provider] ?? provider,
      models: models.filter((m) => m.provider === provider),
    }))
    .filter((group) => group.models.length > 0);
}

// Shared chip shell: a rounded pill whose label opens a Popover (the trigger)
// plus an optional × button that clears the selection directly, no popover
// round-trip needed. `title` carries the full (untruncated) selection text.
function ChipShell({
  label,
  title,
  active,
  disabled,
  onClear,
  clearLabel,
  triggerTestId,
  children,
}: {
  label: string;
  title: string;
  active: boolean;
  disabled?: boolean;
  onClear?: () => void;
  clearLabel: string;
  triggerTestId?: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <span
        title={title}
        aria-disabled={disabled || undefined}
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
          active ? "border-primary/40 bg-primary/5 text-foreground" : "text-muted-foreground",
          // Same reasoning as GatedButton: the disabled <button> inside dispatches
          // no pointer events, so the cursor and the `title` have to live on the
          // wrapper or neither is ever reachable.
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            data-testid={triggerTestId}
            className="max-w-[140px] truncate"
          >
            {label}
          </button>
        </PopoverTrigger>
        {onClear && (
          <button
            type="button"
            aria-label={clearLabel}
            disabled={disabled}
            onClick={onClear}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </span>
      <PopoverContent side="top" align="start" className="w-72 p-0">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="border-b p-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus
        className="h-8 w-full rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );
}

export function AccountChip({ field, disabled }: { field: ComposerAccountsField; disabled?: boolean }) {
  const [search, setSearch] = useState("");
  // A denied chip is inert: there is nothing behind it to open, and leaving it
  // clickable invites the user to hunt for accounts that will never appear.
  const isDisabled = disabled || field.disabled || Boolean(field.denied);
  const selected = field.available.filter((a) => field.selectedIds.includes(a.accountId));
  const label = field.denied
    ? "No account access"
    : field.loading
      ? "Loading…"
      : selected.length === 0
        ? "Select accounts"
        : selected.length === 1
          ? selected[0].name
          : `${selected.length} accounts`;
  const title = field.denied
    ? field.denied
    : selected.length > 0
      ? selected.map((a) => a.name).join(", ")
      : "Select accounts";
  const filtered = field.available.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <ChipShell
      label={label}
      title={title}
      active={selected.length > 0}
      disabled={isDisabled}
      clearLabel="Clear accounts"
      triggerTestId="account-chip-trigger"
      onClear={selected.length > 0 ? () => field.onChange([]) : undefined}
    >
      <SearchBox value={search} onChange={setSearch} placeholder="Search accounts…" />
      <div className="max-h-60 overflow-y-auto p-1">
        {filtered.length === 0 && (
          <p className="p-3 text-center text-xs text-muted-foreground">No matching accounts</p>
        )}
        {filtered.map((account) => (
          <label
            key={account.accountId}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted"
          >
            <Checkbox
              checked={field.selectedIds.includes(account.accountId)}
              onCheckedChange={(checked) => {
                field.onChange(
                  checked
                    ? [...field.selectedIds, account.accountId]
                    : field.selectedIds.filter((id) => id !== account.accountId),
                );
              }}
              className="h-4 w-4"
            />
            <span className="truncate">{account.name}</span>
          </label>
        ))}
      </div>
    </ChipShell>
  );
}

export function ModelChip({ field, disabled }: { field: ComposerModelField; disabled?: boolean }) {
  const [search, setSearch] = useState("");
  const isDisabled = disabled || field.disabled;
  const selected = field.available.find((m) => m.id === field.selectedId);
  const label = field.available.length === 0 ? "No providers configured" : selected?.label ?? "Select model";
  const filtered = field.available.filter((m) => m.label.toLowerCase().includes(search.toLowerCase()));
  const groups = groupModelsByProvider(filtered);

  return (
    <ChipShell
      label={label}
      title={selected?.label ?? "Select model"}
      active={!!selected}
      disabled={isDisabled}
      clearLabel="Clear model"
      triggerTestId="model-chip-trigger"
      onClear={selected ? () => field.onChange("") : undefined}
    >
      {field.available.length > 0 && (
        <SearchBox value={search} onChange={setSearch} placeholder="Search models…" />
      )}
      <div className="max-h-60 overflow-y-auto p-1">
        {field.available.length === 0 && (
          <p className="p-3 text-center text-xs text-muted-foreground">
            No LLM providers configured. Add one in Settings → Providers.
          </p>
        )}
        {field.available.length > 0 && groups.length === 0 && (
          <p className="p-3 text-center text-xs text-muted-foreground">No matching models</p>
        )}
        {groups.map((group) => (
          <div key={group.provider} className="mb-1">
            <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </p>
            {group.models.map((model) => (
              <button
                type="button"
                key={model.id}
                data-testid={`model-option-${model.id}`}
                onClick={() => field.onChange(model.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <Check className={cn("h-3.5 w-3.5 shrink-0", model.id === field.selectedId ? "opacity-100" : "opacity-0")} />
                <span className="truncate">{model.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </ChipShell>
  );
}

export function SkillChip({ field, disabled }: { field: ComposerSkillField; disabled?: boolean }) {
  // Denied ⇒ inert. "No skill" would otherwise read as a choice the user made.
  const isDisabled = disabled || field.disabled || Boolean(field.denied);
  const selected = field.available.find((s) => s.id === field.selectedId);
  const label = field.denied ? "No skill access" : (selected?.name ?? "No skill");

  return (
    <ChipShell
      label={label}
      title={field.denied ?? selected?.description ?? "No skill selected"}
      active={!!selected}
      disabled={isDisabled}
      clearLabel="Clear skill"
      triggerTestId="skill-chip-trigger"
      onClear={selected ? () => field.onChange(null) : undefined}
    >
      <div className="max-h-60 overflow-y-auto p-1">
        <button
          type="button"
          onClick={() => field.onChange(null)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
        >
          <Check className={cn("h-3.5 w-3.5 shrink-0", !field.selectedId ? "opacity-100" : "opacity-0")} />
          <span>No skill</span>
        </button>
        {field.available.map((skill) => (
          <button
            type="button"
            key={skill.id}
            onClick={() => field.onChange(skill.id)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
          >
            <Check className={cn("h-3.5 w-3.5 shrink-0", skill.id === field.selectedId ? "opacity-100" : "opacity-0")} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{skill.name}</p>
              <p className="truncate text-[10px] text-muted-foreground">{skill.description}</p>
            </div>
          </button>
        ))}
      </div>
    </ChipShell>
  );
}

// Multi-select checkbox list shared by the KB and tools sections inside the
// Composer's "+" popover — plain list, no search (both lists are short in
// practice; the monolith's MCP search box is dropped as YAGNI here).
function CheckList({
  items,
  selectedIds,
  onToggle,
  emptyLabel,
  disabled,
}: {
  items: Array<{ id: string; label: string; sublabel?: string }>;
  selectedIds: string[];
  onToggle: (id: string, checked: boolean) => void;
  emptyLabel: string;
  disabled?: boolean;
}) {
  if (items.length === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="max-h-40 overflow-y-auto">
      {items.map((item) => (
        <label
          key={item.id}
          className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-xs hover:bg-muted"
        >
          <Checkbox
            checked={selectedIds.includes(item.id)}
            onCheckedChange={(checked) => onToggle(item.id, checked === true)}
            disabled={disabled}
            className="h-4 w-4"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate">{item.label}</p>
            {item.sublabel && <p className="truncate text-[10px] text-muted-foreground">{item.sublabel}</p>}
          </div>
        </label>
      ))}
    </div>
  );
}

export function KbSection({ field, disabled }: { field: ComposerKbField; disabled?: boolean }) {
  const isDisabled = disabled || field.disabled;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Knowledge base
        </p>
        {field.selectedIds.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isDisabled}
            className="h-5 px-1.5 text-[10px]"
            onClick={() => field.onChange([])}
          >
            Clear
          </Button>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">
        {field.selectedIds.length === 0 ? "All (auto-select)" : `${field.selectedIds.length} selected`}
      </p>
      <CheckList
        items={field.available.map((kb) => ({ id: kb.id, label: kb.name }))}
        selectedIds={field.selectedIds}
        emptyLabel="No knowledge bases available"
        disabled={isDisabled}
        onToggle={(id, checked) =>
          field.onChange(checked ? [...field.selectedIds, id] : field.selectedIds.filter((x) => x !== id))
        }
      />
    </div>
  );
}

export function ToolsSection({ field, disabled }: { field: ComposerToolsField; disabled?: boolean }) {
  const isDisabled = disabled || field.disabled || Boolean(field.denied);
  return (
    <div className="space-y-1.5 border-t pt-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tools</p>
        {field.selectedIds.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isDisabled}
            className="h-5 px-1.5 text-[10px]"
            onClick={() => field.onChange([])}
          >
            Clear
          </Button>
        )}
      </div>
      <CheckList
        items={field.available.map((tool) => ({ id: tool.id, label: tool.name, sublabel: tool.description }))}
        selectedIds={field.selectedIds}
        emptyLabel={
          field.denied ?? (field.loading ? "Loading…" : "No connected tools available")
        }
        disabled={isDisabled}
        onToggle={(id, checked) =>
          field.onChange(checked ? [...field.selectedIds, id] : field.selectedIds.filter((x) => x !== id))
        }
      />
    </div>
  );
}
