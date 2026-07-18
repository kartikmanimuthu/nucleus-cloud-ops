"use client";

// Per-session picker state + fetching, extracted from SessionView to keep it
// under the size budget. This is a MOVE of the monolith's local picker wiring
// (chat-interface.tsx: accounts / provider-models / skills / mcp-servers /
// knowledge-bases + the transport body builder), reshaped into the leaf
// components' field contracts (ComposerContext, RunRail context) plus the
// stable `body` function useChatSession expects.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClientAccountService } from "@/lib/client-account-service";
import type { UIAccount } from "@/lib/types";
import { useProviderModels, defaultModelId } from "@/lib/queries/providers";
import { useKnowledgeBases } from "@/lib/queries/knowledge-base";
import type { ComposerContext } from "./composer-pickers";

interface McpServerOption {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface SessionRailContext {
  accountNames: string[];
  modelLabel: string;
  skillName: string | null;
  toolCount: number | null;
  kbLabel: string;
}

export interface UseSessionPickersResult {
  /**
   * Stable, ref-backed request-body builder for useChatSession. Re-reads the
   * latest picker snapshot on every call, so the transport can capture it once
   * and still send current values (threadId/model/mode/accounts/skill/tools/KB).
   */
  body: () => Record<string, unknown>;
  composerContext: ComposerContext;
  railContext: SessionRailContext;
  agentMode: string;
  setAgentMode: (mode: string) => void;
  autoApprove: boolean;
  setAutoApprove: (value: boolean) => void;
  showTools: boolean;
  setShowTools: (value: boolean) => void;
}

export function useSessionPickers({
  threadId,
  skillLocked,
}: {
  threadId: string;
  /** Locks ONLY the skill chip once a run has started (monolith parity). */
  skillLocked: boolean;
}): UseSessionPickersResult {
  // ── Accounts ───────────────────────────────────────────────────────────────
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);

  // ── Model (tenant-configured providers only) ────────────────────────────────
  const { data: availableModels = [] } = useProviderModels();
  const [selectedModel, setSelectedModel] = useState("");

  // ── Skills ──────────────────────────────────────────────────────────────────
  const [availableSkills, setAvailableSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);

  // ── MCP servers → tools ─────────────────────────────────────────────────────
  const [mcpServers, setMcpServers] = useState<McpServerOption[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>([]);

  // ── Knowledge bases (empty selection ⇒ server auto-selects) ─────────────────
  const { data: knowledgeBases = [] } = useKnowledgeBases();
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);

  // ── Composer settings ───────────────────────────────────────────────────────
  const [agentMode, setAgentMode] = useState("fast");
  const [autoApprove, setAutoApprove] = useState(true);
  const [showTools, setShowTools] = useState(false);

  // Preselect the default provider's chat model; preserve an explicit user pick
  // across refetches (chat-interface.tsx:636-640).
  useEffect(() => {
    setSelectedModel((prev) =>
      prev && availableModels.some((m) => m.id === prev) ? prev : defaultModelId(availableModels),
    );
  }, [availableModels]);

  // Fetch accounts on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setAccountsLoading(true);
        const { accounts: fetched } = await ClientAccountService.getAccounts({
          statusFilter: "active",
          connectionFilter: "connected",
          limit: 1000,
        });
        if (!cancelled) setAccounts(fetched);
      } catch (error) {
        console.error("[useSessionPickers] Failed to load accounts:", error);
      } finally {
        if (!cancelled) setAccountsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch skills on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/skills");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setAvailableSkills(data.skills || []);
        }
      } catch (error) {
        console.error("[useSessionPickers] Failed to load skills:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch MCP servers on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setMcpLoading(true);
        const res = await fetch("/api/mcp-servers");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setMcpServers(data.servers || []);
        }
      } catch (error) {
        console.error("[useSessionPickers] Failed to load MCP servers:", error);
      } finally {
        if (!cancelled) setMcpLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Active-only capability filter (parity with chat-interface.tsx:2406/2524).
  const activeKbs = useMemo(() => knowledgeBases.filter((kb) => kb.status === "active"), [knowledgeBases]);
  const enabledMcp = useMemo(() => mcpServers.filter((s) => s.enabled), [mcpServers]);
  const selectedAccounts = useMemo(
    () => accounts.filter((a) => selectedAccountIds.includes(a.accountId)),
    [accounts, selectedAccountIds],
  );

  // Stable, ref-backed body builder — the ref is refreshed on every render so
  // the transport (which may capture `body` once) always reads live values.
  const bodyStateRef = useRef<Record<string, unknown>>({});
  bodyStateRef.current = {
    threadId,
    autoApprove,
    model: selectedModel,
    mode: agentMode,
    accounts:
      selectedAccounts.length > 0
        ? selectedAccounts.map((a) => ({ accountId: a.accountId, accountName: a.name }))
        : undefined,
    selectedSkill: selectedSkill || undefined,
    mcpServerIds: selectedMcpServerIds.length > 0 ? selectedMcpServerIds : undefined,
    knowledgeBaseIds: selectedKbIds.length > 0 ? selectedKbIds : undefined,
  };
  const body = useCallback(() => ({ ...bodyStateRef.current }), []);

  const composerContext: ComposerContext = useMemo(
    () => ({
      accounts: {
        available: accounts.map((a) => ({ accountId: a.accountId, name: a.name })),
        selectedIds: selectedAccountIds,
        onChange: setSelectedAccountIds,
        loading: accountsLoading,
      },
      model: {
        available: availableModels.map((m) => ({ id: m.id, label: m.label, provider: m.provider })),
        selectedId: selectedModel,
        onChange: setSelectedModel,
      },
      skill: {
        available: availableSkills,
        selectedId: selectedSkill,
        onChange: setSelectedSkill,
        disabled: skillLocked,
      },
      kb: {
        available: activeKbs.map((kb) => ({ id: kb.id, name: kb.name })),
        selectedIds: selectedKbIds,
        onChange: setSelectedKbIds,
      },
      tools: {
        available: enabledMcp.map((s) => ({ id: s.id, name: s.name, description: s.description })),
        selectedIds: selectedMcpServerIds,
        onChange: setSelectedMcpServerIds,
        loading: mcpLoading,
      },
    }),
    [
      accounts,
      selectedAccountIds,
      accountsLoading,
      availableModels,
      selectedModel,
      availableSkills,
      selectedSkill,
      skillLocked,
      activeKbs,
      selectedKbIds,
      enabledMcp,
      selectedMcpServerIds,
      mcpLoading,
    ],
  );

  const railContext: SessionRailContext = useMemo(
    () => ({
      accountNames: selectedAccounts.map((a) => a.name),
      modelLabel: availableModels.find((m) => m.id === selectedModel)?.label ?? selectedModel,
      skillName: availableSkills.find((s) => s.id === selectedSkill)?.name ?? null,
      toolCount: null,
      kbLabel:
        selectedKbIds.length > 0 ? `Knowledge: ${selectedKbIds.length} selected` : "Knowledge: All (auto)",
    }),
    [selectedAccounts, availableModels, selectedModel, availableSkills, selectedSkill, selectedKbIds],
  );

  return {
    body,
    composerContext,
    railContext,
    agentMode,
    setAgentMode,
    autoApprove,
    setAutoApprove,
    showTools,
    setShowTools,
  };
}
