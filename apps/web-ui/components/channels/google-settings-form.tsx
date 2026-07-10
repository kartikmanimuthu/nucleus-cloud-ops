'use client';

import { Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppCredentialsCard } from '@/components/channels/app-credentials-card';
import { ConnectionsCard } from '@/components/channels/connections-card';
import { ConnectorCallbackToast } from '@/components/channels/connector-callback-toast';

interface GoogleSettingsFormProps {
  backHref?: string;
  backLabel?: string;
}

export function GoogleSettingsForm({ backHref = '/app/channels', backLabel = 'Back to Channels' }: GoogleSettingsFormProps) {
  const router = useRouter();
  return (
    <div className="flex-1 bg-background max-w-3xl mx-auto space-y-6">
      <Suspense fallback={null}>
        <ConnectorCallbackToast displayName="Google" />
      </Suspense>
      <Button variant="ghost" size="sm" className="gap-2 -ml-2 text-muted-foreground hover:text-foreground" onClick={() => router.push(backHref)}>
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </Button>
      <div>
        <h1 className="text-2xl font-bold">Google Integration</h1>
        <p className="text-muted-foreground mt-1">Connect a Google account for Gmail and Calendar access.</p>
      </div>
      <AppCredentialsCard provider="google" displayName="Google" helpUrl="https://console.cloud.google.com/apis/credentials" />
      <ConnectionsCard
        provider="google"
        displayName="Google"
        description="Connect your Google account for Gmail and Calendar access."
        emptyHint="Grants the agent access to read & send Gmail and read & manage Calendar events."
      />
    </div>
  );
}
