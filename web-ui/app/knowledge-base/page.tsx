'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, Loader2, Plus, Database, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import type { KnowledgeBase } from '@/lib/knowledge-base/types';

export default function KnowledgeBasePage() {
  const router = useRouter();
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBase | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchKBs = async () => {
    try {
      const res = await fetch('/api/knowledge-base');
      if (!res.ok) throw new Error('Failed to fetch knowledge bases');
      const data = await res.json();
      setKnowledgeBases(data.knowledgeBases ?? []);
    } catch (error) {
      console.error('Error fetching knowledge bases:', error);
      toast.error('Failed to load knowledge bases');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKBs();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      toast.error('Name is required');
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('/api/knowledge-base', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: formName.trim(), description: formDescription.trim() || undefined }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to create knowledge base');
      }

      toast.success('Knowledge base created');
      setDialogOpen(false);
      setFormName('');
      setFormDescription('');
      await fetchKBs();
    } catch (error) {
      console.error('Error creating knowledge base:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to create knowledge base');
    } finally {
      setCreating(false);
    }
  };

  const openDialog = () => {
    setFormName('');
    setFormDescription('');
    setDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/knowledge-base/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Delete failed');
      toast.success(`"${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
      await fetchKBs();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex-1 p-4 md:p-8 pt-6 bg-background">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BookOpen className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Knowledge Base</h1>
              <p className="text-muted-foreground mt-0.5 text-sm">
                Manage your knowledge bases and the documents they contain.
              </p>
            </div>
          </div>
          <Button onClick={openDialog} className="gap-2">
            <Plus className="h-4 w-4" />
            Create Knowledge Base
          </Button>
        </div>

        {/* Card grid */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : knowledgeBases.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
            <Database className="h-12 w-12 text-muted-foreground/40" />
            <div>
              <p className="text-lg font-medium">No knowledge bases yet</p>
              <p className="text-muted-foreground text-sm mt-1">
                Create your first knowledge base to start ingesting documents.
              </p>
            </div>
            <Button onClick={openDialog} variant="outline" className="gap-2 mt-2">
              <Plus className="h-4 w-4" />
              Create Knowledge Base
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {knowledgeBases.map((kb) => (
              <Card key={kb.id} className="flex flex-col hover:border-primary/50 transition-colors">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-base font-semibold leading-snug">{kb.name}</CardTitle>
                    <Badge
                      variant={kb.status === 'active' ? 'secondary' : 'outline'}
                      className={`text-xs ml-2 shrink-0 ${kb.status === 'active' ? 'text-green-600' : 'text-muted-foreground'}`}
                    >
                      {kb.status === 'active' ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                  {kb.description && (
                    <CardDescription className="text-sm leading-relaxed mt-1">
                      {kb.description}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="mt-auto pt-0 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {kb.vectorCount.toLocaleString()} vectors &middot; {kb.dataSourceCount} source{kb.dataSourceCount !== 1 ? 's' : ''}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => router.push(`/knowledge-base/${kb.id}`)}
                    >
                      Open
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(kb); }}
                      title="Delete knowledge base"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create KB Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Knowledge Base</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label htmlFor="kb-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="kb-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Engineering Docs"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-description">Description</Label>
              <Textarea
                id="kb-description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Optional — describe what this knowledge base contains"
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating} className="gap-2">
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete KB confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete knowledge base?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{deleteTarget?.name}&rdquo; and all its data sources and vectors. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
