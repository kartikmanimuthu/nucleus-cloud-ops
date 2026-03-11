'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  CheckCircle2,
  Database,
  File,
  FileText,
  GitBranch,
  Globe,
  Loader2,
  MessageSquare,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import type { DataSource, DataSourceType, KnowledgeBase } from '@/lib/knowledge-base/types';

// ---------------------------------------------------------------------------
// Icons per source type
// ---------------------------------------------------------------------------

function DataSourceIcon({ sourceType, className }: { sourceType: DataSourceType; className?: string }) {
  switch (sourceType) {
    case 'file-upload':
      return <FileText className={className} />;
    case 's3-bucket':
      return <Database className={className} />;
    case 'confluence':
      return <Globe className={className} />;
    case 'bitbucket':
      return <GitBranch className={className} />;
  }
}

const SOURCE_TYPE_LABELS: Record<DataSourceType, string> = {
  'file-upload': 'File Upload',
  's3-bucket': 'S3 Bucket',
  confluence: 'Confluence',
  bitbucket: 'Bitbucket',
};

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: DataSource['status'] }) {
  switch (status) {
    case 'synced':
      return (
        <Badge variant="secondary" className="gap-1 text-xs text-green-600">
          <CheckCircle2 className="h-3 w-3" />
          Synced
        </Badge>
      );
    case 'syncing':
      return (
        <Badge variant="secondary" className="gap-1 text-xs text-blue-600">
          <Loader2 className="h-3 w-3 animate-spin" />
          Syncing
        </Badge>
      );
    case 'error':
      return (
        <Badge variant="destructive" className="text-xs">
          Error
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-xs text-muted-foreground">
          Pending
        </Badge>
      );
  }
}

// ---------------------------------------------------------------------------
// Upload state
// ---------------------------------------------------------------------------

type UploadPhase = 'idle' | 'uploading' | 'embedding' | 'done' | 'error';

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function KnowledgeBaseDetailPage() {
  const router = useRouter();
  const params = useParams<{ kbId: string }>();
  const kbId = params.kbId;

  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);

  const [uploadPhase, setUploadPhase] = useState<UploadPhase>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- Fetch KB details ---------------------------------------------------
  const fetchKB = useCallback(async () => {
    try {
      const res = await fetch(`/api/knowledge-base/${kbId}`);
      if (!res.ok) {
        if (res.status === 404) {
          toast.error('Knowledge base not found');
          router.push('/knowledge-base');
          return;
        }
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

  useEffect(() => {
    fetchKB();
  }, [fetchKB]);

  // ---- File upload --------------------------------------------------------
  const uploadFile = async (file: File) => {
    if (uploadPhase !== 'idle') return;

    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      toast.error('File exceeds 10 MB limit');
      return;
    }

    setUploadError(null);
    setUploadPhase('uploading');

    try {
      const formData = new FormData();
      formData.append('file', file);

      setUploadPhase('embedding');
      const res = await fetch(`/api/knowledge-base/${kbId}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Upload failed');
      }

      setUploadPhase('done');
      toast.success(`"${file.name}" uploaded and embedded successfully`);
      await fetchKB();

      setTimeout(() => setUploadPhase('idle'), 2000);
    } catch (error) {
      console.error('Upload error:', error);
      const msg = error instanceof Error ? error.message : 'Upload failed';
      setUploadError(msg);
      setUploadPhase('error');
      toast.error(msg);
    }
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    // Reset input so same file can be re-uploaded if needed
    e.target.value = '';
  };

  // ---- Delete data source ------------------------------------------------
  const deleteDataSource = async (dsId: string, dsName: string) => {
    try {
      const res = await fetch(`/api/knowledge-base/${kbId}/sources/${dsId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Delete failed');
      }
      toast.success(`"${dsName}" removed`);
      await fetchKB();
    } catch (error) {
      console.error('Error deleting data source:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete data source');
    }
  };

  // ---- Upload zone label -------------------------------------------------
  function uploadZoneLabel() {
    switch (uploadPhase) {
      case 'uploading':
        return 'Uploading…';
      case 'embedding':
        return 'Embedding chunks — this may take a moment…';
      case 'done':
        return 'Done!';
      case 'error':
        return uploadError ?? 'Upload failed';
      default:
        return null;
    }
  }

  // ---- Render ------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-24 bg-background">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!kb) return null;

  const uploadLabel = uploadZoneLabel();
  const isUploading = uploadPhase === 'uploading' || uploadPhase === 'embedding';

  return (
    <div className="flex-1 p-4 md:p-8 pt-6 bg-background">
      <div className="max-w-4xl mx-auto space-y-6">

        {/* Back nav */}
        <button
          onClick={() => router.push('/knowledge-base')}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Knowledge Bases
        </button>

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold">{kb.name}</h1>
            {kb.description && (
              <p className="text-muted-foreground text-sm">{kb.description}</p>
            )}
          </div>
          <Badge
            variant={kb.status === 'active' ? 'secondary' : 'outline'}
            className={`text-xs shrink-0 mt-1 ${kb.status === 'active' ? 'text-green-600' : 'text-muted-foreground'}`}
          >
            {kb.status === 'active' ? 'Active' : 'Inactive'}
          </Badge>
        </div>

        {/* Stats bar and Ask Knowledge Base button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{kb.vectorCount.toLocaleString()}</span>{' '}
              vectors
            </span>
            <span>
              <span className="font-semibold text-foreground">{kb.dataSourceCount}</span>{' '}
              data source{kb.dataSourceCount !== 1 ? 's' : ''}
            </span>
          </div>
          <Button
            variant="default"
            size="sm"
            className="gap-1.5"
            onClick={() => router.push(`/knowledge-base/ask?kb=${kbId}`)}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Ask Knowledge Base
          </Button>
        </div>

        {/* File upload dropzone */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Upload className="h-4 w-4" />
              Upload a File
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              role="button"
              tabIndex={0}
              aria-label="Drop files here or click to upload"
              className={`
                border-2 border-dashed rounded-lg p-10 flex flex-col items-center justify-center gap-3 text-center
                transition-colors cursor-pointer select-none
                ${dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30'}
                ${isUploading ? 'pointer-events-none opacity-60' : ''}
                ${uploadPhase === 'error' ? 'border-destructive/50' : ''}
              `}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleFileDrop}
              onClick={() => !isUploading && fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
            >
              {isUploading ? (
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              ) : uploadPhase === 'done' ? (
                <CheckCircle2 className="h-8 w-8 text-green-500" />
              ) : uploadPhase === 'error' ? (
                <X className="h-8 w-8 text-destructive" />
              ) : (
                <File className="h-8 w-8 text-muted-foreground/50" />
              )}

              <div className="space-y-1">
                {uploadLabel ? (
                  <p className={`text-sm font-medium ${uploadPhase === 'error' ? 'text-destructive' : ''}`}>
                    {uploadLabel}
                  </p>
                ) : (
                  <>
                    <p className="text-sm font-medium">Drop files here or click to upload</p>
                    <p className="text-xs text-muted-foreground">
                      PDF, Markdown, Text, CSV, JSON, YAML — up to 10 MB
                    </p>
                  </>
                )}
              </div>

              {uploadPhase === 'error' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(e) => { e.stopPropagation(); setUploadPhase('idle'); setUploadError(null); }}
                >
                  Try again
                </Button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".pdf,.md,.txt,.csv,.json,.yaml,.yml,text/*,application/pdf,application/json"
              onChange={handleFileInput}
            />
          </CardContent>
        </Card>

        {/* Data sources list */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Data Sources</CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => router.push(`/knowledge-base/${kbId}/sources/new`)}
              >
                <Plus className="h-3.5 w-3.5" />
                Add Data Source
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
                        {ds.lastSyncAt && ` · Synced ${new Date(ds.lastSyncAt).toLocaleDateString()}`}
                      </p>
                      {ds.status === 'error' && ds.lastSyncError && (
                        <p className="text-xs text-destructive truncate">{ds.lastSyncError}</p>
                      )}
                    </div>

                    {/* Status */}
                    <StatusBadge status={ds.status} />

                    {/* Delete */}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                          <span className="sr-only">Delete {ds.name}</span>
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete data source?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will permanently delete &ldquo;{ds.name}&rdquo; and all{' '}
                            {ds.vectorCount > 0 ? `${ds.vectorCount.toLocaleString()} ` : ''}
                            associated vectors. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive hover:bg-destructive/90"
                            onClick={() => deleteDataSource(ds.id, ds.name)}
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
