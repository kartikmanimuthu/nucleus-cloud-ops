'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { BookOpen, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KBChat } from '@/components/knowledge-base/kb-chat';

function KnowledgeBaseAskContent() {
  const searchParams = useSearchParams();
  const kbIdFromParams = searchParams.get('kb') ?? undefined;

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Page header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b shrink-0 bg-background">
        <Button variant="ghost" size="sm" asChild className="h-8 w-8 p-0">
          <Link href="/app/knowledge-base" aria-label="Back to Knowledge Bases">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <BookOpen className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">Knowledge Base Chat</h1>
      </div>

      {/* Chat — fills remaining height */}
      <div className="flex-1 min-h-0">
        <KBChat initialKbId={kbIdFromParams} />
      </div>
    </div>
  );
}

export default function KnowledgeBaseAskPage() {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <KnowledgeBaseAskContent />
    </Suspense>
  );
}
