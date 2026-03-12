'use client';

import { useCallback, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, File, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { KBSourceTypeSelector } from '@/components/knowledge-base/kb-source-type-selector';
import { toast } from 'sonner';
import type { DataSourceType } from '@/lib/knowledge-base/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SyncPhase = 'idle' | 'creating' | 'syncing' | 'done' | 'error';

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function FieldRow({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File Upload form
// ---------------------------------------------------------------------------

function FileUploadForm({ kbId }: { kbId: string }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'embedding' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const uploadFile = useCallback(
    async (file: File) => {
      if (phase !== 'idle') return;
      const MAX_SIZE = 10 * 1024 * 1024;
      if (file.size > MAX_SIZE) {
        toast.error('File exceeds 10 MB limit');
        return;
      }
      setErrorMsg(null);
      setPhase('uploading');
      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(`/api/knowledge-base/${kbId}/upload`, {
          method: 'POST',
          body: formData,
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? 'Upload failed');
        }
        setPhase('done');
        toast.success(`"${file.name}" queued for processing`);
        router.push(`/knowledge-base/${kbId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setErrorMsg(msg);
        setPhase('error');
        toast.error(msg);
      }
    },
    [kbId, phase, router],
  );

  const isUploading = phase === 'uploading';

  const zoneLabel = () => {
    switch (phase) {
      case 'uploading':
        return 'Uploading…';
      case 'embedding':
        return 'Embedding chunks — this may take a moment…';
      case 'done':
        return 'Done!';
      case 'error':
        return errorMsg ?? 'Upload failed';
      default:
        return null;
    }
  };

  const label = zoneLabel();

  return (
    <div className="space-y-3 mt-4">
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop files here or click to upload"
        className={`
          border-2 border-dashed rounded-lg p-10 flex flex-col items-center justify-center gap-3 text-center
          transition-colors cursor-pointer select-none
          ${dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30'}
          ${isUploading ? 'pointer-events-none opacity-60' : ''}
          ${phase === 'error' ? 'border-destructive/50' : ''}
        `}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) uploadFile(file);
        }}
        onClick={() => !isUploading && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
        }}
      >
        {isUploading ? (
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        ) : phase === 'done' ? (
          <CheckCircle2 className="h-8 w-8 text-green-500" />
        ) : phase === 'error' ? (
          <X className="h-8 w-8 text-destructive" />
        ) : (
          <File className="h-8 w-8 text-muted-foreground/50" />
        )}

        <div className="space-y-1">
          {label ? (
            <p className={`text-sm font-medium ${phase === 'error' ? 'text-destructive' : ''}`}>
              {label}
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

        {phase === 'error' && (
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              setPhase('idle');
              setErrorMsg(null);
            }}
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
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) uploadFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// S3 Bucket form
// ---------------------------------------------------------------------------

function S3BucketForm({
  kbId,
  phase,
  setPhase,
}: {
  kbId: string;
  phase: SyncPhase;
  setPhase: (p: SyncPhase) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [bucketName, setBucketName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [filePatterns, setFilePatterns] = useState('');
  const [region, setRegion] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !bucketName.trim()) return;

    setPhase('creating');
    setErrorMsg(null);

    try {
      const createRes = await fetch(`/api/knowledge-base/${kbId}/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          sourceType: 's3-bucket',
          config: {
            bucketName: bucketName.trim(),
            prefix: prefix.trim() || undefined,
            filePatterns: filePatterns.trim()
              ? filePatterns.split(',').map((p) => p.trim()).filter(Boolean)
              : undefined,
            region: region.trim() || undefined,
          },
        }),
      });

      if (!createRes.ok) {
        const data = await createRes.json();
        throw new Error(data.error ?? 'Failed to create data source');
      }

      const { dataSource } = await createRes.json();

      // Enqueue sync — returns 202 immediately
      await fetch(`/api/knowledge-base/${kbId}/sources/${dataSource.id}/sync`, { method: 'POST' });

      setPhase('done');
      toast.success(`"${name}" added — syncing in background`);
      router.push(`/knowledge-base/${kbId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Operation failed';
      setErrorMsg(msg);
      setPhase('error');
      toast.error(msg);
    }
  };

  const isBusy = phase === 'creating' || phase === 'syncing';

  return (
    <form onSubmit={handleSubmit} className="space-y-4 mt-4">
      <FieldRow label="Data Source Name" required>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My S3 Bucket"
          required
          disabled={isBusy}
        />
      </FieldRow>
      <FieldRow label="Bucket Name" required>
        <Input
          value={bucketName}
          onChange={(e) => setBucketName(e.target.value)}
          placeholder="my-documents-bucket"
          required
          disabled={isBusy}
        />
      </FieldRow>
      <FieldRow label="Prefix">
        <Input
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder="data/documents/"
          disabled={isBusy}
        />
      </FieldRow>
      <FieldRow label="File Patterns">
        <Input
          value={filePatterns}
          onChange={(e) => setFilePatterns(e.target.value)}
          placeholder="*.pdf,*.md"
          disabled={isBusy}
        />
        <p className="text-xs text-muted-foreground">Comma-separated glob patterns</p>
      </FieldRow>
      <FieldRow label="Region">
        <Input
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          placeholder="us-east-1"
          disabled={isBusy}
        />
      </FieldRow>

      {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}

      <Button type="submit" disabled={isBusy || !name.trim() || !bucketName.trim()}>
        {isBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {phase === 'creating' ? 'Creating…' : phase === 'syncing' ? 'Syncing…' : 'Add and Sync'}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Confluence form
// ---------------------------------------------------------------------------

function ConfluenceForm({
  kbId,
  phase,
  setPhase,
}: {
  kbId: string;
  phase: SyncPhase;
  setPhase: (p: SyncPhase) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [spaceKey, setSpaceKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [pageIds, setPageIds] = useState('');
  const [confluenceEmail, setConfluenceEmail] = useState('');
  const [confluenceApiToken, setConfluenceApiToken] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !spaceKey.trim() || !baseUrl.trim()) return;

    setPhase('creating');
    setErrorMsg(null);

    try {
      const createRes = await fetch(`/api/knowledge-base/${kbId}/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          sourceType: 'confluence',
          config: {
            spaceKey: spaceKey.trim(),
            baseUrl: baseUrl.trim(),
            mcpServerId: '',
            pageIds: pageIds.trim()
              ? pageIds.split(',').map((p) => p.trim()).filter(Boolean)
              : undefined,
            email: confluenceEmail.trim() || undefined,
            apiToken: confluenceApiToken.trim() || undefined,
          },
        }),
      });

      if (!createRes.ok) {
        const data = await createRes.json();
        throw new Error(data.error ?? 'Failed to create data source');
      }

      const { dataSource } = await createRes.json();

      // Enqueue sync — returns 202 immediately
      await fetch(`/api/knowledge-base/${kbId}/sources/${dataSource.id}/sync`, { method: 'POST' });

      setPhase('done');
      toast.success(`"${name}" added — syncing in background`);
      router.push(`/knowledge-base/${kbId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Operation failed';
      setErrorMsg(msg);
      setPhase('error');
      toast.error(msg);
    }
  };

  const isBusy = phase === 'creating' || phase === 'syncing';

  return (
    <form onSubmit={handleSubmit} className="space-y-4 mt-4">
      <FieldRow label="Name" required>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Confluence Docs"
          required
          disabled={isBusy}
        />
      </FieldRow>
      <FieldRow label="Space Key" required>
        <Input
          value={spaceKey}
          onChange={(e) => setSpaceKey(e.target.value)}
          placeholder="MYSPACE"
          required
          disabled={isBusy}
        />
      </FieldRow>
      <FieldRow label="Base URL" required>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://mycompany.atlassian.net"
          required
          disabled={isBusy}
        />
      </FieldRow>
      <FieldRow label="Atlassian Email">
        <Input
          type="email"
          value={confluenceEmail}
          onChange={(e) => setConfluenceEmail(e.target.value)}
          placeholder="you@company.com"
          disabled={isBusy}
        />
      </FieldRow>
      <FieldRow label="API Token">
        <Input
          type="password"
          value={confluenceApiToken}
          onChange={(e) => setConfluenceApiToken(e.target.value)}
          placeholder="Your Atlassian API token"
          disabled={isBusy}
        />
        <p className="text-xs text-muted-foreground">Required for private Confluence spaces</p>
      </FieldRow>
      <FieldRow label="Page IDs">
        <Input
          value={pageIds}
          onChange={(e) => setPageIds(e.target.value)}
          placeholder="123456,789012"
          disabled={isBusy}
        />
        <p className="text-xs text-muted-foreground">
          Comma-separated page IDs. Leave blank to import entire space.
        </p>
      </FieldRow>

      {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}

      <Button
        type="submit"
        disabled={isBusy || !name.trim() || !spaceKey.trim() || !baseUrl.trim()}
      >
        {isBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {phase === 'creating' ? 'Creating…' : phase === 'syncing' ? 'Syncing…' : 'Add and Sync'}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Bitbucket form
// ---------------------------------------------------------------------------

function BitbucketForm({
  kbId,
  phase,
  setPhase,
}: {
  kbId: string;
  phase: SyncPhase;
  setPhase: (p: SyncPhase) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [project, setProject] = useState('');
  const [repoSlug, setRepoSlug] = useState('');
  const [branch, setBranch] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [paths, setPaths] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !workspace.trim() || !email.trim() || !apiToken.trim()) return;

    setPhase('creating');
    setErrorMsg(null);

    try {
      const createRes = await fetch(`/api/knowledge-base/${kbId}/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          sourceType: 'bitbucket',
          config: {
            workspace: workspace.trim(),
            project: project.trim() || undefined,
            repoSlug: repoSlug.trim() || undefined,
            branch: branch.trim() || undefined,
            email: email.trim(),
            apiToken: apiToken.trim(),
            paths: paths.trim()
              ? paths.split(',').map((p) => p.trim()).filter(Boolean)
              : undefined,
          },
        }),
      });

      if (!createRes.ok) {
        const data = await createRes.json();
        throw new Error(data.error ?? 'Failed to create data source');
      }

      const { dataSource: bbDs } = await createRes.json();
      await fetch(`/api/knowledge-base/${kbId}/sources/${bbDs.id}/sync`, { method: 'POST' });

      setPhase('done');
      toast.success(`"${name}" added — syncing in background`);
      router.push(`/knowledge-base/${kbId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Operation failed';
      setErrorMsg(msg);
      setPhase('error');
      toast.error(msg);
    }
  };

  const isBusy = phase === 'creating' || phase === 'syncing';
  const isValid = name.trim() && workspace.trim() && email.trim() && apiToken.trim();

  return (
    <form onSubmit={handleSubmit} className="space-y-4 mt-4">
      <FieldRow label="Name" required>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Repo Docs" required disabled={isBusy} />
      </FieldRow>
      <FieldRow label="Workspace" required>
        <Input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="my-workspace" required disabled={isBusy} />
        <p className="text-xs text-muted-foreground">All repos in the workspace will be scraped unless project or repo is specified.</p>
      </FieldRow>
      <FieldRow label="Project Key">
        <Input value={project} onChange={(e) => setProject(e.target.value)} placeholder="MYPROJECT" disabled={isBusy} />
        <p className="text-xs text-muted-foreground">Optional — scrape only repos under this project.</p>
      </FieldRow>
      <FieldRow label="Repository Slug">
        <Input value={repoSlug} onChange={(e) => setRepoSlug(e.target.value)} placeholder="my-repo" disabled={isBusy} />
        <p className="text-xs text-muted-foreground">Optional — scrape only this specific repo.</p>
      </FieldRow>
      <FieldRow label="Branch">
        <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Defaults to main or master" disabled={isBusy} />
      </FieldRow>
      <FieldRow label="Atlassian Email" required>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required disabled={isBusy} />
      </FieldRow>
      <FieldRow label="API Token" required>
        <Input type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} placeholder="Your Atlassian API token" required disabled={isBusy} />
        <p className="text-xs text-muted-foreground">
          Generate at{' '}
          <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" className="underline">
            id.atlassian.com
          </a>
          . App passwords are no longer supported.
        </p>
      </FieldRow>
      <FieldRow label="File Paths">
        <Input value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="docs/,src/README.md" disabled={isBusy} />
        <p className="text-xs text-muted-foreground">Comma-separated paths. Leave blank to sync all supported files.</p>
      </FieldRow>

      {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}

      <Button type="submit" disabled={isBusy || !isValid}>
        {isBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {phase === 'creating' ? 'Creating…' : phase === 'syncing' ? 'Syncing…' : 'Add and Sync'}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AddDataSourcePage() {
  const router = useRouter();
  const params = useParams<{ kbId: string }>();
  const kbId = params.kbId;

  const [selectedType, setSelectedType] = useState<DataSourceType | null>(null);
  const [syncPhase, setSyncPhase] = useState<SyncPhase>('idle');

  return (
    <div className="flex-1 p-4 md:p-8 pt-6 bg-background">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Back nav */}
        <button
          onClick={() => router.push(`/knowledge-base/${kbId}`)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Knowledge Base
        </button>

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">Add Data Source</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Choose a source type and configure it to add content to your knowledge base.
          </p>
        </div>

        {/* Step 1: Type selector */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Step 1 — Select Source Type</CardTitle>
          </CardHeader>
          <CardContent>
            <KBSourceTypeSelector
              selected={selectedType}
              onSelect={(type) => {
                setSelectedType(type);
                setSyncPhase('idle');
              }}
            />
          </CardContent>
        </Card>

        {/* Step 2: Config form */}
        {selectedType && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Step 2 — Configure</CardTitle>
            </CardHeader>
            <CardContent>
              {selectedType === 'file-upload' && <FileUploadForm kbId={kbId} />}
              {selectedType === 's3-bucket' && (
                <S3BucketForm kbId={kbId} phase={syncPhase} setPhase={setSyncPhase} />
              )}
              {selectedType === 'confluence' && (
                <ConfluenceForm kbId={kbId} phase={syncPhase} setPhase={setSyncPhase} />
              )}
              {selectedType === 'bitbucket' && (
                <BitbucketForm kbId={kbId} phase={syncPhase} setPhase={setSyncPhase} />
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
