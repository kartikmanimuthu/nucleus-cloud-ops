'use client';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface WorkspaceBotCardProps {
  botConfigured: boolean;
  botAccountLabel: string | null;
  disabled?: boolean;
}

export function WorkspaceBotCard({ botConfigured, botAccountLabel, disabled = false }: WorkspaceBotCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Workspace bot</CardTitle>
            <CardDescription>Install the Slack app in your workspace to enable slash commands and notifications.</CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {botConfigured ? <Badge variant="secondary">{botAccountLabel ?? 'Installed'}</Badge> : null}
            <Button onClick={() => { window.location.href = '/api/slack/install'; }} disabled={disabled}>
              Add to Slack
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          Installed once per workspace. If your workspace restricts app installs, Slack will ask for your admin&apos;s
          approval. Powers slash commands and the bot posting messages.
        </p>
      </CardContent>
    </Card>
  );
}
