'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, CheckCircle2, Database, File, Loader2, MessageSquare,
  Plus, RefreshCw, Trash2, Upload, X, Eye, Pencil, AlertCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import type { DataSource, DataSourceType, KnowledgeBase } from '@/lib/knowledge-base/types';
import { formatDateTime, formatDate } from '@/lib/date-utils';
import { useTenant } from '@/lib/tenant-context';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_TYPE_LABELS: Record<DataSourceType, string> = {
  'file-upload': 'File Upload',
  's3-bucket': 'S3 Bucket',
  'confluence': 'Confluence',
  'bitbucket': 'Bitbucket',
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DataSourceIcon({ sourceType, className }: { sourceType: DataSourceType; className?: string }) {
  switch (sourceType) {
    case 'confluence': return <span className={className} title="Confluence">🌐</span>;
    case 'bitbucket': return <span className={className} title="Bitbucket">🪣</span>;
    case 's3-bucket': return <span className={className} title="S3 Bucket">☁️</span>;
    default: return <File className={className} />;
  }
}

function StatusBadge({ status, error }: { status: DataSource['status']; error?: string }) {
  if (status === 'synced') {
    return (
      <Badge variant="outline" className="text-green-600 border-green-300 gap-1 shrink-0">
        <CheckCircle2 className="h-3 w-3" /> Synced
      </Badge>
    );
  }
  if (status === 'syncing') {
    return (
      <Badge variant="outline" className="text-blue-600 border-blue-300 gap-1 shrink-0">
        <Loader2 className="h-3 w-3 animate-spin" /> Syncing…
      </Badge>
    );
  }
  if (status === 'pending') {
    return (
      <Badge variant="outline" className="text-yellow-600 border-yellow-300 gap-1 shrink-0">
        <Loader2 className="h-3 w-3 animate-spin" /> Pending…
      </Badge>
    );
  }
  // error
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="text-destructive border-destructive/40 gap-1 shrink-0 cursor-help">
            <AlertCircle className="h-3 w-3" /> Error
          </Badge>
        </TooltipTrigger>
        {error && <TooltipContent className="max-w-xs text-xs">{error}</TooltipContent>}
      </Tooltip>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// View dialog — shows data source config read-only
// ---------------------------------------------------------------------------

function ViewDialog({ ds, open, onClose }: { ds: DataSource; open: boolean; onClose: () => void }) {
  const config = ds.config as Record<string, unknown>;
  const rows = Object.entries(config).filter(([k]) => k !== 'apiToken');

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DataSourceIcon sourceType={ds.sourceType} className="h-4 w-4" />
            {ds.name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Type</span>
            <span className="font-medium">{SOURCE_TYPE_LABELS[ds.sourceType]}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Status</span>
            <StatusBadge status={ds.status} error={ds.lastErrorMessage ?? ds.lastSyncError} />
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Vectors</span>
            <span className="font-medium">{ds.vectorCount.toLocaleString()}</span>
          </div>
          {ds.lastSyncAt && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last synced</span>
              <span className="font-medium">{formatDateTime(ds.lastSyncAt, undefined, timezone)}</span>
            </div>
          )}
          {rows.length > 0 && (
            <div className="border-t pt-3 space-y-2">
              {rows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <span className="text-muted-foreground capitalize">{k.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <span className="font-medium text-right truncate max-w-[200px]">{Array.isArray(v) ? v.join(', ') : String(v ?? '—')}</span>
                </div>
              ))}
            </div>
          )}
          {(ds.lastErrorMessage || ds.lastSyncError) && (
            <div className="border-t pt-3 space-y-1">
              <p className="text-xs font-medium text-destructive">{ds.lastErrorMessage ?? ds.lastSyncError}</p>
              {ds.lastErrorDetail && (
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-all max-h-40 overflow-y-auto bg-muted/40 rounded p-2">
                  {ds.lastErrorDetail}
                </pre>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit dialog — editable name + config fields (non-sensitive)
// ---------------------------------------------------------------------------

function EditDialog({ ds, open, onClose, onSaved }: { ds: DataSource; open: boolean; onClose: () => void; onSaved: (updated: DataSource) => void }) {
  const [name, setName] = useState(ds.name);
  const [config, setConfig] = useState<Record<string, string>>(() => {
    const c = ds.config as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(c)
        .filter(([k]) => !['apiToken', 'chunkCount', 'fileSize', 'mimeType', 's3Key'].includes(k))
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])
    );
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Parse array fields back
      const parsedConfig: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(config)) {
        if (k === 'filePatterns' || k === 'pageIds' || k === 'paths') {
          parsedConfig[k] = v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        } else {
          parsedConfig[k] = v || undefined;
        }
      }
      const res = await fetch(`/api/knowledge-base/${ds.knowledgeBaseId}/sources/${ds.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), config: parsedConfig }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Save failed');
      const { dataSource } = await res.json();
      toast.success('Data source updated');
      onSaved(dataSource);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // File-upload sources have no editable config
  const isFileUpload = ds.sourceType === 'file-upload';

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Data Source</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
          </div>
          {!isFileUpload && Object.entries(config).map(([k, v]) => (
            <div key={k} className="space-y-1.5">
              <Label className="capitalize">{k.replace(/([A-Z])/g, ' $1').trim()}</Label>
              <Input
                value={v}
                onChange={(e) => setConfig((prev) => ({ ...prev, [k]: e.target.value }))}
                disabled={saving}
                placeholder={k === 'filePatterns' || k === 'pageIds' || k === 'paths' ? 'Comma-separated' : undefined}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type UploadPhase = 'idle' | 'uploading' | 'done' | 'error';

export default function KnowledgeBaseDetailPage() {
  const router = useRouter();
  const params = useParams<{ kbId: string }>();
  const kbId = params.kbId;
  const { timezone } = useTenant();

  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);

  const [uploadPhase, setUploadPhase] = useState<UploadPhase>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [viewDs, setViewDs] = useState<DataSource | null>(null);
  const [editDs, setEditDs] = useState<DataSource | null>(null);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [deletingKb, setDeletingKb] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- Fetch KB details ---------------------------------------------------
  const fetchKB = useCallback(async () => {
    try {
      const res = await fetch(`/api/knowledge-base/${kbId}`);
      if (!res.ok) {
        if (res.status === 404) { toast.error('Knowledge base not found'); router.push('/app/knowledge-base'); return; }
        throw new Error('Failed to fetch knowledge base');
      }
      const data = await res.json();
      setKb(data.knowledgeBase);
      setDataSources(data.dataSources ?? []);
    } catch (error) {
      console.error('Error fetching knowledge base:', error);
      toast.error('Failed to load knowledge base');
    } finally {
      setLoading(false);
    }
  }, [kbId, router]);

  useEffect(() => { fetchKB(); }, [fetchKB]);

  // ---- Polling: refresh when any DS is in-progress -----------------------
  useEffect(() => {
    const hasInProgress = dataSources.some((ds) => ds.status === 'syncing' || ds.status === 'pending');
    if (hasInProgress && !pollRef.current) {
      pollRef.current = setInterval(fetchKB, 3000);
    } else if (!hasInProgress && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [dataSources, fetchKB]);

  // ---- File upload --------------------------------------------------------
  const uploadFile = async (file: File) => {
    if (uploadPhase !== 'idle') return;
    if (file.size > 10 * 1024 * 1024) { toast.error('File exceeds 10 MB limit'); return; }

    setUploadError(null);
    setUploadPhase('uploading');

    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/knowledge-base/${kbId}/upload`, { method: 'POST', body: formData });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? 'Upload failed'); }

      setUploadPhase('done');
      toast.success(`"${file.name}" queued for processing`);
      await fetchKB();
      setTimeout(() => setUploadPhase('idle'), 2000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Upload failed';
      setUploadError(msg);
      setUploadPhase('error');
      toast.error(msg);
    }
  };

  // ---- Re-sync -----------------------------------------------------------
  const resyncDataSource = async (ds: DataSource) => {
    setSyncingIds((prev) => new Set(prev).add(ds.id));
    try {
      const res = await fetch(`/api/knowledge-base/${kbId}/sources/${ds.id}/sync`, { method: 'POST' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? 'Sync failed'); }
      toast.success(`"${ds.name}" sync started`);
      await fetchKB();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sync failed');
    } finally {
      setSyncingIds((prev) => { const s = new Set(prev); s.delete(ds.id); return s; });
    }
  };

  // ---- Delete knowledge base ---------------------------------------------
  const deleteKnowledgeBase = async () => {
    setDeletingKb(true);
    try {
      const res = await fetch(`/api/knowledge-base/${kbId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Delete failed');
      toast.success(`"${kb?.name}" deleted`);
      router.push('/app/knowledge-base');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete knowledge base');
      setDeletingKb(false);
    }
  };

  // ---- Delete data source ------------------------------------------------
  const deleteDataSource = async (dsId: string, dsName: string) => {
    try {
      const res = await fetch(`/api/knowledge-base/${kbId}/sources/${dsId}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? 'Delete failed'); }
      toast.success(`"${dsName}" removed`);
      await fetchKB();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete data source');
    }
  };

  // ---- Render ------------------------------------------------------------
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-24 bg-background">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!kb) return null;

  const isUploading = uploadPhase === 'uploading';

  return (
    <div className="flex-1 p-4 md:p-8 pt-6 bg-background">
      <div className="max-w-4xl mx-auto space-y-6">

        {/* Back nav */}
        <button onClick={() => router.push('/app/knowledge-base')} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Knowledge Bases
        </button>

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold">{kb.name}</h1>
            {kb.description && <p className="text-muted-foreground text-sm">{kb.description}</p>}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={kb.status === 'active' ? 'secondary' : 'outline'} className={`text-xs shrink-0 ${kb.status === 'active' ? 'text-green-600' : 'text-muted-foreground'}`}>
              {kb.status === 'active' ? 'Active' : 'Inactive'}
            </Badge>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="Delete knowledge base">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete knowledge base?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete &ldquo;{kb.name}&rdquo; and all its data sources and vectors. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deletingKb}>Cancel</AlertDialogCancel>
                  <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={deleteKnowledgeBase} disabled={deletingKb}>
                    {deletingKb && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* Stats + Ask button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <span><span className="font-semibold text-foreground">{kb.vectorCount.toLocaleString()}</span> vectors</span>
            <span><span className="font-semibold text-foreground">{kb.dataSourceCount}</span> data source{kb.dataSourceCount !== 1 ? 's' : ''}</span>
          </div>
          <Button variant="default" size="sm" className="gap-1.5" onClick={() => router.push(`/app/knowledge-base/ask?kb=${kbId}`)}>
            <MessageSquare className="h-3.5 w-3.5" /> Ask Knowledge Base
          </Button>
        </div>

        {/* File upload dropzone */}
        {/* <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Upload className="h-4 w-4" /> Upload a File</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              role="button" tabIndex={0} aria-label="Drop files here or click to upload"
              className={`border-2 border-dashed rounded-lg p-10 flex flex-col items-center justify-center gap-3 text-center transition-colors cursor-pointer select-none
                ${dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30'}
                ${isUploading ? 'pointer-events-none opacity-60' : ''}
                ${uploadPhase === 'error' ? 'border-destructive/50' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) uploadFile(f); }}
              onClick={() => !isUploading && fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
            >
              {isUploading ? <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                : uploadPhase === 'done' ? <CheckCircle2 className="h-8 w-8 text-green-500" />
                : uploadPhase === 'error' ? <X className="h-8 w-8 text-destructive" />
                : <File className="h-8 w-8 text-muted-foreground/50" />}
              <div className="space-y-1">
                {uploadPhase === 'uploading' ? <p className="text-sm font-medium">Uploading…</p>
                  : uploadPhase === 'done' ? <p className="text-sm font-medium">Queued for processing</p>
                  : uploadPhase === 'error' ? <p className="text-sm font-medium text-destructive">{uploadError}</p>
                  : <>
                    <p className="text-sm font-medium">Drop files here or click to upload</p>
                    <p className="text-xs text-muted-foreground">PDF, Markdown, Text, CSV, JSON, YAML — up to 10 MB</p>
                  </>}
              </div>
              {uploadPhase === 'error' && (
                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setUploadPhase('idle'); setUploadError(null); }}>Try again</Button>
              )}
            </div>
            <input ref={fileInputRef} type="file" className="hidden"
              accept=".pdf,.md,.txt,.csv,.json,.yaml,.yml,text/*,application/pdf,application/json"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ''; }} />
          </CardContent>
        </Card> */}

        {/* Data sources list */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Data Sources</CardTitle>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => router.push(`/app/knowledge-base/${kbId}/sources/new`)}>
                <Plus className="h-3.5 w-3.5" /> Add Data Source
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {dataSources.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2 text-center text-muted-foreground">
                <Database className="h-8 w-8 opacity-30" />
                <p className="text-sm">No data sources yet. Upload a file or add a data source above.</p>
              </div>
            ) : (
              <div className="divide-y">
                {dataSources.map((ds) => (
                  <div key={ds.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    {/* Icon */}
                    <div className="p-1.5 rounded bg-muted/50 shrink-0">
                      <DataSourceIcon sourceType={ds.sourceType} className="h-4 w-4 text-muted-foreground" />
                    </div>

                    {/* Details */}
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <p className="text-sm font-medium truncate">{ds.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {SOURCE_TYPE_LABELS[ds.sourceType]}
                        {ds.vectorCount > 0 && ` · ${ds.vectorCount.toLocaleString()} vectors`}
                        {ds.lastSyncAt && ` · Synced ${formatDate(ds.lastSyncAt, 'shortDate', timezone)}`}
                      </p>
                    </div>

                    {/* Status */}
                    <StatusBadge status={ds.status} error={ds.lastErrorMessage ?? ds.lastSyncError} />

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      {/* View */}
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setViewDs(ds)} title="View details">
                        <Eye className="h-4 w-4" />
                      </Button>

                      {/* Edit */}
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setEditDs(ds)} title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>

                      {/* Re-sync (not for file-upload) */}
                      {ds.sourceType !== 'file-upload' && (
                        <Button
                          variant="ghost" size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          disabled={ds.status === 'syncing' || ds.status === 'pending' || syncingIds.has(ds.id)}
                          onClick={() => resyncDataSource(ds)}
                          title="Re-sync"
                        >
                          <RefreshCw className={`h-4 w-4 ${syncingIds.has(ds.id) ? 'animate-spin' : ''}`} />
                        </Button>
                      )}

                      {/* Delete */}
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="Delete">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete data source?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently delete &ldquo;{ds.name}&rdquo; and all {ds.vectorCount > 0 ? `${ds.vectorCount.toLocaleString()} ` : ''}associated vectors.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => deleteDataSource(ds.id, ds.name)}>Delete</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* View dialog */}
      {viewDs && <ViewDialog ds={viewDs} open={!!viewDs} onClose={() => setViewDs(null)} />}

      {/* Edit dialog */}
      {editDs && (
        <EditDialog
          ds={editDs}
          open={!!editDs}
          onClose={() => setEditDs(null)}
          onSaved={(updated) => {
            setDataSources((prev) => prev.map((d) => d.id === updated.id ? updated : d));
            setEditDs(null);
          }}
        />
      )}
    </div>
  );
}
