'use client';

import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/ui/data-table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { KeyValueEditor } from './key-value-editor';
import { useTestMcpServer } from '@/lib/queries/mcp-servers';
import { formRowsToConfig, type McpFormRow, type McpFormValues } from '@/lib/agent/mcp-form-schema';
import { Plus, Trash2, Plug, Loader2, CheckCircle2, Pencil, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';

interface McpServerFormProps {
  value: McpFormValues;
  onChange: (value: McpFormValues) => void;
  apiPath: string;
  /**
   * Decided by the parent, which knows which route backs this editor and
   * therefore which subject guards it (`update AIOps` vs `update Settings`).
   * Passed in rather than resolved here so the form has one source of truth.
   */
  readOnly?: boolean;
  /** Shown on every disabled control. */
  readOnlyReason?: string | null;
}

function blankStdioRow(): McpFormRow {
  return { id: '', type: 'stdio', command: '', args: [], env: [], requiresAwsCredentials: false, disabled: false };
}

function transportLabel(t: McpFormRow['type']) {
  if (t === 'stdio') return 'stdio (local)';
  if (t === 'sse') return 'SSE (remote)';
  return 'HTTP (remote)';
}

function summaryLine(row: McpFormRow) {
  if (row.type === 'stdio') return [row.command, ...row.args].filter(Boolean).join(' ') || 'No command set';
  return row.url || 'No URL set';
}

export function McpServerForm({ value, onChange, apiPath, readOnly = false, readOnlyReason }: McpServerFormProps) {
  const rows = value.servers;
  const test = useTestMcpServer(apiPath);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const updateRow = (i: number, next: McpFormRow) => {
    onChange({ servers: rows.map((r, idx) => (idx === i ? next : r)) });
  };

  const removeRow = (i: number) => {
    const row = rows[i];
    if (!confirm(`Delete MCP server "${row.id || 'this server'}"?`)) return;
    onChange({ servers: rows.filter((_, idx) => idx !== i) });
    setEditingIndex((current) => {
      if (current === null) return current;
      if (current === i) { setSheetOpen(false); return null; }
      return current > i ? current - 1 : current;
    });
  };

  const addRow = () => {
    onChange({ servers: [...rows, blankStdioRow()] });
    setEditingIndex(rows.length);
    setSheetOpen(true);
  };

  const openEdit = (i: number) => {
    setEditingIndex(i);
    setSheetOpen(true);
  };

  const changeTransport = (i: number, t: 'stdio' | 'sse' | 'http') => {
    const r = rows[i];
    if (t === 'stdio') updateRow(i, { id: r.id, type: 'stdio', command: '', args: [], env: [], requiresAwsCredentials: false, disabled: r.disabled });
    else updateRow(i, { id: r.id, type: t, url: '', headers: [], disabled: r.disabled });
  };

  const runTest = async (row: McpFormRow) => {
    const { config, error } = formRowsToConfig([row]);
    if (error || !row.id.trim()) {
      toast.error(error || 'Give the server an ID before testing');
      return;
    }
    const entry = config.mcpServers[row.id.trim()];
    setTestingId(row.id);
    try {
      const result = await test.mutateAsync({ id: row.id.trim(), entry });
      if (result.success) toast.success(`Connected — ${result.toolCount ?? 0} tool(s) discovered`);
      else toast.error(result.error || 'Connection failed');
    } catch (e: unknown) {
      toast.error((e as Error)?.message || 'Connection test failed');
    } finally {
      setTestingId(null);
    }
  };

  const editing = editingIndex !== null ? rows[editingIndex] : null;
  const editingBusy = editing !== null && testingId === editing.id && test.isPending;

  const columns = useMemo<ColumnDef<McpFormRow>[]>(() => [
    {
      accessorKey: 'id',
      header: 'Server',
      cell: ({ row }) => {
        const r = row.original;
        return (
          <button type="button" onClick={() => openEdit(row.index)} className="text-left min-w-0 max-w-[380px] block">
            <div className={`font-medium font-mono text-sm truncate hover:underline ${r.id.trim() ? '' : 'italic text-muted-foreground'}`}>
              {r.id.trim() || 'Untitled server'}
            </div>
            <div className="text-xs text-muted-foreground truncate font-mono">{summaryLine(r)}</div>
          </button>
        );
      },
    },
    {
      accessorKey: 'type',
      header: 'Transport',
      cell: ({ row }) => <Badge variant="outline" className="font-mono text-[11px]">{transportLabel(row.original.type)}</Badge>,
    },
    {
      accessorKey: 'disabled',
      header: 'Status',
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex items-center gap-2">
            <span className={readOnly ? 'inline-flex cursor-not-allowed' : undefined} title={readOnly ? (readOnlyReason ?? undefined) : undefined}>
              <Switch
                checked={!r.disabled}
                disabled={readOnly}
                onCheckedChange={(c) => updateRow(row.index, { ...r, disabled: !c })}
                aria-label={r.disabled ? 'Enable server' : 'Disable server'}
              />
            </span>
            <span className="text-xs text-muted-foreground w-14">{r.disabled ? 'Disabled' : 'Enabled'}</span>
          </div>
        );
      },
    },
    {
      id: 'actions',
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => {
        const r = row.original;
        const busy = testingId === r.id && test.isPending;
        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0" aria-label="Open actions menu">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Edit opens the detail sheet, which is itself read-only when denied. */}
                <DropdownMenuItem onClick={() => openEdit(row.index)}>
                  <Pencil className="mr-2 h-4 w-4" /> {readOnly ? 'View' : 'Edit'}
                </DropdownMenuItem>
                {/* Test connection dials the server with stored credentials — a
                    write-ish side effect, and its route declares `update`. */}
                <DropdownMenuItem
                  onClick={readOnly ? undefined : () => runTest(r)}
                  disabled={busy || readOnly}
                  title={readOnly ? (readOnlyReason ?? undefined) : undefined}
                  className={readOnly ? 'cursor-not-allowed' : undefined}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" /> Test connection
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={readOnly ? undefined : () => removeRow(row.index)}
                  onSelect={readOnly ? (e) => e.preventDefault() : undefined}
                  disabled={readOnly}
                  aria-disabled={readOnly || undefined}
                  title={readOnly ? (readOnlyReason ?? undefined) : undefined}
                  className={readOnly ? 'cursor-not-allowed' : 'text-destructive'}
                >
                  <Trash2 className="mr-2 h-4 w-4" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [rows, testingId, test.isPending]);

  return (
    <div className="space-y-3">
      <DataTable
        columns={columns}
        data={rows}
        enableSorting={false}
        enableFiltering={false}
        enablePagination={false}
        emptyMessage="No MCP servers configured. Add one to get started."
        header={
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {rows.length} server{rows.length !== 1 ? 's' : ''} configured
            </span>
            {/*
              Adding a row only edits the LOCAL draft — no request is made until
              Save. That is exactly why it needed gating: a denied user could fill
              in a server, watch the row appear, then get a 403 from Save while the
              row stayed on screen looking created.
            */}
            <span className={readOnly ? 'inline-flex cursor-not-allowed' : undefined} title={readOnly ? (readOnlyReason ?? undefined) : undefined}>
              <Button type="button" size="sm" onClick={addRow} disabled={readOnly} className="h-8 text-xs gap-1.5">
                <Plus className="h-3.5 w-3.5" /> Add MCP server
              </Button>
            </span>
          </div>
        }
      />

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="sm:max-w-lg overflow-y-auto flex flex-col gap-0">
          {editing && editingIndex !== null && (
            <>
              <SheetHeader>
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Plug className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <SheetTitle className="font-mono text-base truncate">{editing.id.trim() || 'New MCP server'}</SheetTitle>
                    <SheetDescription>
                      {editing.type === 'stdio' ? 'Local process launched via stdio' : `Remote server over ${editing.type.toUpperCase()}`}
                    </SheetDescription>
                  </div>
                </div>
              </SheetHeader>

              <div className="space-y-4 py-4 flex-1">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Server ID</Label>
                  <Input className="h-9 text-sm" value={editing.id} placeholder="my-server" disabled={readOnly} onChange={(e) => updateRow(editingIndex, { ...editing, id: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Transport</Label>
                  <Select value={editing.type} disabled={readOnly} onValueChange={(v) => changeTransport(editingIndex, v as 'stdio' | 'sse' | 'http')}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stdio">stdio (local)</SelectItem>
                      <SelectItem value="sse">SSE (remote)</SelectItem>
                      <SelectItem value="http">HTTP (remote)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {editing.type === 'stdio' ? (
                  <>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Command</Label>
                      <Input className="h-9 text-sm font-mono" value={editing.command} placeholder="uvx" disabled={readOnly} onChange={(e) => updateRow(editingIndex, { ...editing, command: e.target.value })} />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Arguments (one per line)</Label>
                      <textarea
                        className="min-h-[64px] rounded-md border bg-background px-3 py-2 text-xs font-mono"
                        value={editing.args.join('\n')}
                        placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                        onChange={(e) => updateRow(editingIndex, { ...editing, args: e.target.value.split('\n') })}
                      />
                    </div>
                    <KeyValueEditor label="Environment variables" value={editing.env} onChange={(env) => updateRow(editingIndex, { ...editing, env })} keyPlaceholder="VAR_NAME" disabled={readOnly} />
                    <div className="flex items-center gap-2">
                      <Switch checked={editing.requiresAwsCredentials} disabled={readOnly} onCheckedChange={(c) => updateRow(editingIndex, { ...editing, requiresAwsCredentials: c })} id="aws-creds" />
                      <Label htmlFor="aws-creds" className="text-xs">Inject AWS credentials for the selected account</Label>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Endpoint URL</Label>
                      <Input className="h-9 text-sm font-mono" value={editing.url} placeholder="https://api.example.com/sse" disabled={readOnly} onChange={(e) => updateRow(editingIndex, { ...editing, url: e.target.value })} />
                    </div>
                    <KeyValueEditor label="Headers" value={editing.headers} onChange={(headers) => updateRow(editingIndex, { ...editing, headers })} keyPlaceholder="Authorization" valuePlaceholder="Bearer ..." disabled={readOnly} />
                  </>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <Switch checked={!editing.disabled} disabled={readOnly} onCheckedChange={(c) => updateRow(editingIndex, { ...editing, disabled: !c })} id="enabled" />
                  <Label htmlFor="enabled" className="text-xs">Enabled</Label>
                </div>
              </div>

              <div className="flex items-center justify-between border-t pt-4">
                <Button type="button" variant="ghost" disabled={readOnly} title={readOnly ? (readOnlyReason ?? undefined) : undefined} className="h-8 text-xs gap-1.5 text-destructive hover:text-destructive" onClick={() => removeRow(editingIndex)}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete server
                </Button>
                <Button type="button" size="sm" variant="outline" className="h-8 text-xs gap-1.5" disabled={editingBusy || readOnly} title={readOnly ? (readOnlyReason ?? undefined) : undefined} onClick={() => runTest(editing)}>
                  {editingBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  Test connection
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
