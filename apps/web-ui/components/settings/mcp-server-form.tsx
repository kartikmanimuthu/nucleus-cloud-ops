'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { KeyValueEditor } from './key-value-editor';
import { useTestMcpServer } from '@/lib/queries/mcp-servers';
import { formRowsToConfig, type McpFormRow, type McpFormValues } from '@/lib/agent/mcp-form-schema';
import { Plus, Trash2, Plug, Loader2, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

interface McpServerFormProps {
  value: McpFormValues;
  onChange: (value: McpFormValues) => void;
  apiPath: string;
}

function blankStdioRow(): McpFormRow {
  return { id: '', type: 'stdio', command: '', args: [], env: [], requiresAwsCredentials: false, disabled: false };
}

export function McpServerForm({ value, onChange, apiPath }: McpServerFormProps) {
  const rows = value.servers;
  const test = useTestMcpServer(apiPath);
  const [testingId, setTestingId] = useState<string | null>(null);

  const updateRow = (i: number, next: McpFormRow) => {
    onChange({ servers: rows.map((r, idx) => (idx === i ? next : r)) });
  };
  const removeRow = (i: number) => onChange({ servers: rows.filter((_, idx) => idx !== i) });
  const addRow = () => onChange({ servers: [...rows, blankStdioRow()] });

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

  return (
    <div className="space-y-3">
      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground py-6 text-center">No MCP servers configured. Add one below.</p>
      )}

      {rows.map((row, i) => {
        const busy = testingId === row.id && test.isPending;
        return (
          <Card key={i}>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Plug className="h-4 w-4 text-primary" />
                </div>
                <div className="grid gap-1.5 flex-1">
                  <Label className="text-xs">Server ID</Label>
                  <Input className="h-8 text-sm" value={row.id} placeholder="my-server" onChange={(e) => updateRow(i, { ...row, id: e.target.value })} />
                </div>
                <div className="grid gap-1.5 w-40">
                  <Label className="text-xs">Transport</Label>
                  <Select value={row.type} onValueChange={(v) => changeTransport(i, v as 'stdio' | 'sse' | 'http')}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stdio">stdio (local)</SelectItem>
                      <SelectItem value="sse">SSE (remote)</SelectItem>
                      <SelectItem value="http">HTTP (remote)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" size="icon" variant="ghost" className="h-8 w-8 mt-5 flex-shrink-0 text-destructive" onClick={() => removeRow(i)} aria-label="Remove server">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {row.type === 'stdio' ? (
                <div className="space-y-3 pl-11">
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Command</Label>
                    <Input className="h-8 text-sm font-mono" value={row.command} placeholder="uvx" onChange={(e) => updateRow(i, { ...row, command: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Arguments (one per line)</Label>
                    <textarea
                      className="min-h-[64px] rounded-md border bg-background px-3 py-2 text-xs font-mono"
                      value={row.args.join('\n')}
                      placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                      onChange={(e) => updateRow(i, { ...row, args: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
                    />
                  </div>
                  <KeyValueEditor label="Environment variables" value={row.env} onChange={(env) => updateRow(i, { ...row, env })} keyPlaceholder="VAR_NAME" />
                  <div className="flex items-center gap-2">
                    <Switch checked={row.requiresAwsCredentials} onCheckedChange={(c) => updateRow(i, { ...row, requiresAwsCredentials: c })} id={`aws-${i}`} />
                    <Label htmlFor={`aws-${i}`} className="text-xs">Inject AWS credentials for the selected account</Label>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 pl-11">
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Endpoint URL</Label>
                    <Input className="h-8 text-sm font-mono" value={row.url} placeholder="https://api.example.com/sse" onChange={(e) => updateRow(i, { ...row, url: e.target.value })} />
                  </div>
                  <KeyValueEditor label="Headers" value={row.headers} onChange={(headers) => updateRow(i, { ...row, headers })} keyPlaceholder="Authorization" valuePlaceholder="Bearer ..." />
                </div>
              )}

              <div className="flex items-center justify-between pl-11">
                <div className="flex items-center gap-2">
                  <Switch checked={!row.disabled} onCheckedChange={(c) => updateRow(i, { ...row, disabled: !c })} id={`enabled-${i}`} />
                  <Label htmlFor={`enabled-${i}`} className="text-xs">Enabled</Label>
                </div>
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1.5" disabled={busy} onClick={() => runTest(row)}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  Test connection
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <Button type="button" variant="outline" className="w-full gap-1.5" onClick={addRow}>
        <Plus className="h-4 w-4" /> Add MCP server
      </Button>
    </div>
  );
}
