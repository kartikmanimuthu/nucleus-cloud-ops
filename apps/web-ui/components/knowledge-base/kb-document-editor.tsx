'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useCreateDocument, useUpdateDocument } from '@/lib/queries/knowledge-base';
import { MAX_DOCUMENT_CHARS } from '@/lib/knowledge-base/document-validation';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  content: z.string().trim().min(1, 'Content is required').max(MAX_DOCUMENT_CHARS, 'Document is too large'),
});
type FormValues = z.infer<typeof schema>;

interface KBDocumentEditorProps {
  kbId: string;
  /** Existing document to edit; omit for a new document. */
  doc?: { id: string; name: string };
  open: boolean;
  onClose: () => void;
  onSaved: () => void; // caller refreshes the KB
}

export function KBDocumentEditor({ kbId, doc, open, onClose, onSaved }: KBDocumentEditorProps) {
  const isEdit = !!doc;
  const create = useCreateDocument(kbId);
  const update = useUpdateDocument(kbId);
  const [loadingContent, setLoadingContent] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: doc?.name ?? '', content: '' },
  });
  const content = form.watch('content');

  // Load existing content when editing.
  useEffect(() => {
    if (!open) return;
    if (!doc) { form.reset({ name: '', content: '' }); return; }
    setLoadingContent(true);
    fetch(`/api/knowledge-base/${kbId}/documents/${doc.id}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error('Failed to load document')))
      .then((d) => form.reset({ name: d.name ?? doc.name, content: d.content ?? '' }))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load document'))
      .finally(() => setLoadingContent(false));
  }, [open, doc, kbId, form]);

  const submitting = create.isPending || update.isPending;

  const onSubmit = async (values: FormValues) => {
    try {
      if (isEdit && doc) {
        await update.mutateAsync({ dsId: doc.id, name: values.name, content: values.content });
        toast.success(`"${values.name}" updated`);
      } else {
        await create.mutateAsync({ name: values.name, content: values.content });
        toast.success(`"${values.name}" created`);
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Document' : 'New Document'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input placeholder="e.g. Incident runbook" disabled={submitting || loadingContent} {...form.register('name')} />
            {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
          </div>

          <Tabs defaultValue="write">
            <TabsList>
              <TabsTrigger value="write" type="button">Write</TabsTrigger>
              <TabsTrigger value="preview" type="button">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="write">
              <Textarea
                className="min-h-[320px] font-mono text-sm"
                placeholder="Write markdown…"
                disabled={submitting || loadingContent}
                {...form.register('content')}
              />
              {form.formState.errors.content && <p className="text-xs text-destructive">{form.formState.errors.content.message}</p>}
            </TabsContent>
            <TabsContent value="preview">
              <div className="prose prose-sm dark:prose-invert max-w-none min-h-[320px] rounded-md border p-4 overflow-y-auto">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || '_Nothing to preview_'}</ReactMarkdown>
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button type="submit" disabled={submitting || loadingContent}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
