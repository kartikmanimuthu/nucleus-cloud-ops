"use client";

// Per-session picker state + fetching, extracted from SessionView to keep it
// under the size budget. This is a MOVE of the monolith's local picker wiring
// (chat-interface.tsx: accounts / provider-models / skills / mcp-servers /
// knowledge-bases + the transport body builder), reshaped into the leaf
// components' field contracts (ComposerContext, RunRail context) plus the
// stable `body` function useChatSession expects.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProviderModels, defaultModelId } from "@/lib/queries/providers";
import { useKnowledgeBases } from "@/lib/queries/knowledge-base";
import { useAbilityMeta, useCan, useDenialReason } from "@/hooks/use-can";
import { useAccountOptions } from "@/lib/queries/accounts";
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
  autoApprove: boolean;
  setAutoApprove: (value: boolean) => void;
  autoLoadSkills: boolean;
  setAutoLoadSkills: (value: boolean) => void;
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
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const {
    accounts,
    isLoading: accountsLoading,
    denied: accountsDeniedReason,
  } = useAccountOptions({ statusFilter: "active", connectionFilter: "connected", limit: 1000 });

  // `abilityLoaded` still gates the skill and MCP fetches below, which are plain
  // fetches rather than query hooks.
  const { isLoaded: abilityLoaded } = useAbilityMeta();

  /**
   * The skill and MCP lists have their own permissions behind them, and unlike
   * accounts their fetches only checked `res.ok` — so a 403 produced no console
   * error but also no explanation: the pickers rendered "No skill" and "No
   * connected tools available", which claims the tenant has none rather than
   * that this caller may not see them. Silent is not better than noisy here;
   * both misinform.
   *
   * The subjects match what each route actually enforces:
   *   · GET /api/skills      — Layer 1 `authz` declares { read, Skill }
   *   · GET /api/mcp-servers — authorize('read', 'McpServer')
   * A role can reach this workspace without either, so they are asked
   * separately rather than inferred from one another.
   *
   * The MCP check follows its route: it asked `read AIOps` while that route
   * gated on the AIOps catch-all. Both moved to the McpServer row together —
   * asking the module here while the route enforces the subject would re-open
   * the enabled-control-then-403 gap this pairing exists to close.
   */
  const canReadSkills = useCan("read", "Skill");
  const skillsDeniedReason = useDenialReason("read", "Skill");
  const canReadMcp = useCan("read", "McpServer");
  const mcpDeniedReason = useDenialReason("read", "McpServer");

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
  const [autoApprove, setAutoApprove] = useState(true);
  // "Auto skills": auto-select a skill for the task + allow mid-run load_skill.
  const [autoLoadSkills, setAutoLoadSkills] = useState(true);

  // Preselect the default provider's chat model; preserve an explicit user pick
  // across refetches (chat-interface.tsx:636-640).
  useEffect(() => {
    setSelectedModel((prev) =>
      prev && availableModels.some((m) => m.id === prev) ? prev : defaultModelId(availableModels),
    );
  }, [availableModels]);

  // A denied account list must not keep a stale selection travelling in the
  // request body: the server would refuse those accounts and fail the run.
  useEffect(() => {
    if (accountsDeniedReason) setSelectedAccountIds([]);
  }, [accountsDeniedReason]);

  // Fetch skills once the ability is known and permits it.
  useEffect(() => {
    if (!abilityLoaded) return;

    if (!canReadSkills) {
      setAvailableSkills([]);
      // A skill selected before the grant was revoked must not keep travelling
      // in the request body — the server would refuse it and fail the run.
      setSelectedSkill(null);
      return;
    }

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
  }, [abilityLoaded, canReadSkills]);

  // Fetch MCP servers once the ability is known and permits it.
  useEffect(() => {
    if (!abilityLoaded) return;

    if (!canReadMcp) {
      setMcpServers([]);
      setSelectedMcpServerIds([]);
      setMcpLoading(false);
      return;
    }

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
  }, [abilityLoaded, canReadMcp]);

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
    autoLoadSkills,
    model: selectedModel,
    mode: 'deep',
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
        denied: accountsDeniedReason,
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
        denied: canReadSkills ? null : skillsDeniedReason,
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
        // Still "loading" while the ability is in flight: the fetch is deferred
        // until then, and an empty list would otherwise assert "no tools exist".
        loading: mcpLoading || !abilityLoaded,
        denied: canReadMcp ? null : mcpDeniedReason,
      },
    }),
    [
      accounts,
      selectedAccountIds,
      accountsLoading,
      accountsDeniedReason,
      abilityLoaded,
      canReadSkills,
      skillsDeniedReason,
      canReadMcp,
      mcpDeniedReason,
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
    autoApprove,
    setAutoApprove,
    autoLoadSkills,
    setAutoLoadSkills,
  };
}
