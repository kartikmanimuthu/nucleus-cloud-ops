'use client';

import { Plug, Trash2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useConnections, useDeleteConnection, useConnectorApp } from '@/lib/queries/connectors';

interface ConnectionsCardProps {
  provider: string;
  displayName: string;
  description: string;
  emptyHint?: string;
}

export function ConnectionsCard({ provider, displayName, description, emptyHint }: ConnectionsCardProps) {
  const { data: app } = useConnectorApp(provider);
  const { data: connections = [] } = useConnections(provider);
  const del = useDeleteConnection(provider);

  const connect = () => {
    window.location.href = `/api/connections/${provider}/authorize`;
  };

  const onDelete = async (id: string) => {
    try {
      await del.mutateAsync(id);
      toast.success('Disconnected');
    } catch (e: any) {
      toast.error(e.message || 'Failed to disconnect');
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">{displayName}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Button onClick={connect} disabled={!app?.connectReady} className="gap-2 shrink-0">
            {connections.length ? <RefreshCw className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
            {connections.length ? 'Reconnect' : `Connect ${displayName}`}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {connections.length} account{connections.length === 1 ? '' : 's'} connected
        </p>
        {connections.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">{c.accountLabel}</p>
              <p className="text-xs text-muted-foreground">{c.scopes.length} scopes granted</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{c.status === 'active' ? 'Active' : c.status}</Badge>
              <Button variant="ghost" size="icon" className="text-destructive" onClick={() => onDelete(c.id)} disabled={del.isPending}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
        {!connections.length ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No {displayName} account connected.{' '}
            {app?.connectReady ? (emptyHint ?? '') : 'No OAuth app available yet — add your own under Advanced, or ask an admin to configure the managed app.'}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Tokens are encrypted at rest and used only when an agent acts on this org&apos;s behalf.
        </p>
      </CardContent>
    </Card>
  );
}
