'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { Plug, Save, RotateCcw, Check, AlertCircle, Loader2, Info, Copy, Code2, ListChecks } from 'lucide-react';
import Editor, { OnMount } from '@monaco-editor/react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import {
  MCP_CONFIG_JSON_SCHEMA,
  validateMcpConfig,
  defaultsToJson,
  type MCPConfigJson,
} from '@/lib/agent/mcp-config';
import { configToFormRows, formRowsToConfig, mcpFormSchema, type McpFormValues } from '@/lib/agent/mcp-form-schema';
import { McpServerForm } from './mcp-server-form';
import { useMcpConfig, useSaveMcpConfig, useResetMcpConfig } from '@/lib/queries/mcp-servers';
import { GatedButton } from '@/components/rbac/gated';
import { useCan, useDenialReason } from '@/hooks/use-can';

const MONACO_SCHEMA = {
  uri: 'https://nucleus-platform/mcp-config.schema.json',
  fileMatch: ['*'],
  schema: MCP_CONFIG_JSON_SCHEMA,
};

interface MCPSettingsProps {
  apiPath?: string;
}

type Mode = 'form' | 'json';

export function MCPSettings({ apiPath = '/api/mcp-servers' }: MCPSettingsProps) {
  const { resolvedTheme } = useTheme();
  /**
   * ── ONE SUBJECT, BOTH ENDPOINTS ─────────────────────────────────────────────
   * This used to branch on apiPath, because the two routes it serves guarded
   * themselves differently — /api/mcp-servers on 'AIOps', /api/agent-ops/
   * mcp-settings on 'Settings'. Both were module-wide catch-alls that the role
   * editor hides, so neither mount could be granted from the matrix, and the
   * agent-ops one answered to the wrong module entirely (nav-config.ts:41 files
   * MCP Servers under AIOps, not Settings).
   *
   * Both now gate on 'McpServer' — a registry subject that has existed since
   * 20260812100000 and rendered as a grantable row governing nothing. One
   * subject for one editor, so the branch is gone: whichever page mounts this,
   * the same permission decides it.
   */
  const writeSubject = 'McpServer';
  const canWrite = useCan('update', writeSubject);
  const writeDenialReason = useDenialReason('update', writeSubject);

  const { data, isLoading } = useMcpConfig(apiPath);
  const saveMutation = useSaveMcpConfig(apiPath);
  const resetMutation = useResetMcpConfig(apiPath);

  const [mode, setMode] = useState<Mode>('form');
  const [formValues, setFormValues] = useState<McpFormValues>({ servers: [] });
  const [editorValue, setEditorValue] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [isValidJson, setIsValidJson] = useState(true);
  const [savedFlash, setSavedFlash] = useState(false);
  const editorRef = useRef<unknown>(null);

  // Hydrate from server
  useEffect(() => {
    if (!data) return;
    const config = data.config ?? defaultsToJson();
    setFormValues({ servers: configToFormRows(config) });
    setEditorValue(JSON.stringify(config, null, 2));
    setIsCustom(data.isCustom);
  }, [data]);

  const summary = (() => {
    const rows = formValues.servers;
    return { total: rows.length, enabled: rows.filter((r) => !r.disabled).length };
  })();

  const handleEditorChange = useCallback((value: string | undefined) => {
    const val = value || '';
    setEditorValue(val);
    try {
      const parsed = JSON.parse(val);
      setIsValidJson(validateMcpConfig(parsed).ok);
    } catch {
      setIsValidJson(false);
    }
  }, []);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      schemas: [MONACO_SCHEMA],
      allowComments: false,
      trailingCommas: 'error',
    });
    setTimeout(() => editor.getAction('editor.action.formatDocument')?.run(), 200);
  };

  // Build the canonical MCPConfigJson from the active view; returns null on error (after toasting).
  const buildConfig = (): MCPConfigJson | null => {
    if (mode === 'json') {
      try {
        const parsed = JSON.parse(editorValue);
        const v = validateMcpConfig(parsed);
        if (!v.ok) { toast.error(v.error); return null; }
        return parsed as MCPConfigJson;
      } catch {
        toast.error('Invalid JSON'); return null;
      }
    }
    const schemaCheck = mcpFormSchema.safeParse(formValues);
    if (!schemaCheck.success) {
      toast.error(schemaCheck.error.issues[0]?.message || 'Fix form errors before saving');
      return null;
    }
    const { config, error } = formRowsToConfig(formValues.servers);
    if (error) { toast.error(error); return null; }
    const v = validateMcpConfig(config);
    if (!v.ok) { toast.error(v.error); return null; }
    return config;
  };

  const switchMode = (next: Mode) => {
    if (!next || next === mode) return;
    if (next === 'json') {
      // form -> json: serialize current form rows
      const { config, error } = formRowsToConfig(formValues.servers);
      if (error) { toast.error(error); return; }
      setEditorValue(JSON.stringify(config, null, 2));
      setIsValidJson(true);
      setMode('json');
    } else {
      // json -> form: parse + validate, block on error
      try {
        const parsed = JSON.parse(editorValue);
        const v = validateMcpConfig(parsed);
        if (!v.ok) { toast.error(`Fix JSON before switching to Form: ${v.error}`); return; }
        setFormValues({ servers: configToFormRows(parsed as MCPConfigJson) });
        setMode('form');
      } catch {
        toast.error('Fix JSON before switching to Form');
      }
    }
  };

  const handleSave = async () => {
    const config = buildConfig();
    if (!config) return;
    try {
      const res = await saveMutation.mutateAsync(config);
      setFormValues({ servers: configToFormRows(res.config) });
      setEditorValue(JSON.stringify(res.config, null, 2));
      setIsCustom(true);
      setSavedFlash(true);
      toast.success('MCP configuration saved');
      setTimeout(() => setSavedFlash(false), 3000);
    } catch (e) {
      toast.error((e as Error)?.message || 'Failed to save');
    }
  };

  const handleReset = async () => {
    try {
      const res = await resetMutation.mutateAsync();
      setFormValues({ servers: configToFormRows(res.config) });
      setEditorValue(JSON.stringify(res.config, null, 2));
      setIsCustom(false);
      toast.success('Reset to defaults');
    } catch (e) {
      toast.error((e as Error)?.message || 'Failed to reset');
    }
  };

  const saving = saveMutation.isPending || resetMutation.isPending;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-green-500/20 to-emerald-500/20 flex items-center justify-center">
                <Plug className="h-5 w-5 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <CardTitle className="text-lg">MCP Servers Configuration</CardTitle>
                <CardDescription>
                  Configure Model Context Protocol servers for the AI agent. Local (stdio) and remote (SSE / HTTP) transports are supported.
                </CardDescription>
              </div>
            </div>
            {isCustom && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium">
                CUSTOMIZED
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/*
                Every mutation either endpoint exposes — PUT, DELETE (reset) and
                the /test subroute — declares `update McpServer`, so one grant
                governs everything this editor can do, on both mounts.
              */}
              <GatedButton action="update" subject={writeSubject} size="sm" onClick={handleSave} disabled={saving || (mode === 'json' && !isValidJson)} className={cn('h-8 text-xs gap-1.5', savedFlash && 'bg-green-600 hover:bg-green-700')}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : savedFlash ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                {savedFlash ? 'Saved' : 'Save'}
              </GatedButton>
              <GatedButton action="update" subject={writeSubject} size="sm" variant="outline" onClick={handleReset} disabled={!isCustom || saving} className="h-8 text-xs gap-1.5" title="Reset to defaults">
                <RotateCcw className="h-3.5 w-3.5" /> Reset to Defaults
              </GatedButton>
              {mode === 'json' && (
                <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(editorValue)} className="h-8 text-xs gap-1.5" title="Copy">
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            <div className="flex items-center gap-3">
              {mode === 'json' && !isValidJson && (
                <span className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" /> Invalid JSON
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {summary.total} server{summary.total !== 1 ? 's' : ''},{' '}
                <span className={cn(summary.enabled > 0 && 'text-green-600 dark:text-green-400 font-medium')}>{summary.enabled} enabled</span>
              </span>
              <ToggleGroup type="single" value={mode} onValueChange={(v) => switchMode(v as Mode)} size="sm">
                <ToggleGroupItem value="form" className="h-8 px-2 text-xs gap-1.5" aria-label="Form view"><ListChecks className="h-3.5 w-3.5" /> Form</ToggleGroupItem>
                <ToggleGroupItem value="json" className="h-8 px-2 text-xs gap-1.5" aria-label="JSON view"><Code2 className="h-3.5 w-3.5" /> JSON</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          {isLoading ? (
            <div className="h-[420px] flex items-center justify-center bg-muted/20 rounded-lg border">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : mode === 'form' ? (
            <McpServerForm value={formValues} onChange={setFormValues} apiPath={apiPath} readOnly={!canWrite} readOnlyReason={writeDenialReason} />
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <Editor
                height="420px"
                defaultLanguage="json"
                value={editorValue}
                onChange={handleEditorChange}
                onMount={handleEditorMount}
                theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
                options={{
                  // The JSON view edits the SAME config as the form. Leaving it
                  // writable would let a denied caller compose a change, hit an
                  // already-disabled Save, and lose the work — or paste over the
                  // live config and believe it took.
                  readOnly: !canWrite,
                  minimap: { enabled: false }, fontSize: 13, lineNumbers: 'on', folding: true,
                  bracketPairColorization: { enabled: true }, formatOnPaste: true, automaticLayout: true,
                  scrollBeyondLastLine: false, tabSize: 2, wordWrap: 'on', renderLineHighlight: 'line',
                  padding: { top: 12, bottom: 12 }, scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                }}
              />
            </div>
          )}

          <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
            <Info className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Toggle <strong>Form</strong>/<strong>JSON</strong> to edit the same configuration either way. Remote servers use <code className="px-1 py-0.5 rounded bg-muted text-[11px] font-mono">type: &quot;sse&quot;</code> or <code className="px-1 py-0.5 rounded bg-muted text-[11px] font-mono">&quot;http&quot;</code> with a URL.</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
