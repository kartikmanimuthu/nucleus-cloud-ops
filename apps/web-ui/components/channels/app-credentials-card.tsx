'use client';

import { useState, useEffect } from 'react';
import { Copy, CheckCircle2, KeyRound, ChevronRight, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useConnectorApp, useSaveConnectorApp, useDeleteConnectorApp } from '@/lib/queries/connectors';

interface AppCredentialsCardProps {
  provider: string;
  displayName: string;
  showSigningSecret?: boolean;
  helpUrl?: string;
}

export function AppCredentialsCard({ provider, displayName, showSigningSecret = false, helpUrl }: AppCredentialsCardProps) {
  const { data } = useConnectorApp(provider);
  const save = useSaveConnectorApp(provider);
  const remove = useDeleteConnectorApp(provider);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (data?.clientId) setClientId(data.clientId);
  }, [data?.clientId]);

  // Auto-expand the BYO section only when there's no usable app at all
  // (no platform app configured and no tenant app saved) — otherwise stay collapsed.
  useEffect(() => {
    if (data?.appSource === 'none') setOpen(true);
  }, [data?.appSource]);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const onSave = async () => {
    try {
      await save.mutateAsync({ clientId, clientSecret: clientSecret || undefined, signingSecret: signingSecret || undefined });
      setClientSecret('');
      setSigningSecret('');
      toast.success(`${displayName} app credentials saved`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to save');
    }
  };

  const onRemove = async () => {
    try {
      await remove.mutateAsync();
      setClientId('');
      toast.success(`${displayName} app credentials removed`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to remove');
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2">
            <KeyRound className="h-4 w-4 mt-0.5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">{displayName} OAuth app</CardTitle>
              <CardDescription>
                {data?.appSource === 'platform'
                  ? `One-click Connect is enabled using the managed ${displayName} app.`
                  : data?.appSource === 'tenant'
                    ? `Using your own ${displayName} OAuth app.`
                    : `No ${displayName} OAuth app configured yet — add your own below to enable Connect.`}
              </CardDescription>
            </div>
          </div>
          {data?.appSource === 'platform' ? (
            <Badge variant="secondary" className="gap-1 shrink-0"><Sparkles className="h-3.5 w-3.5 text-primary" />Managed</Badge>
          ) : data?.appSource === 'tenant' ? (
            <Badge variant="secondary" className="gap-1 shrink-0"><CheckCircle2 className="h-3.5 w-3.5 text-green-500" />Custom app</Badge>
          ) : (
            <Badge variant="outline" className="shrink-0">Not set</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <details
          className="rounded-lg border px-3 py-2 text-sm [&_svg.disc]:open:rotate-90"
          open={open}
          onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
            <ChevronRight className="disc h-4 w-4 transition-transform" />
            Advanced: use your own {displayName} OAuth app{data?.appSource === 'tenant' ? '' : ' (optional)'}
          </summary>
          <div className="mt-4 space-y-4">
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">
                Register {data?.slackInstallCallbackUrl ? 'these redirect/callback URLs' : 'this redirect/callback URL'} in your {displayName} app:
              </p>
              <div className="flex items-center gap-2">
                <Input readOnly value={data?.callbackUrl ?? ''} className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={() => copy(data?.callbackUrl ?? '', 'cb')}>
                  {copied === 'cb' ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              {data?.slackInstallCallbackUrl ? (
                <div className="flex items-center gap-2">
                  <Input readOnly value={data.slackInstallCallbackUrl} className="font-mono text-xs" />
                  <Button variant="outline" size="icon" onClick={() => copy(data.slackInstallCallbackUrl!, 'cb2')}>
                    {copied === 'cb2' ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              ) : null}
            </div>

            {helpUrl ? (
              <p className="text-xs text-muted-foreground">
                Create an OAuth app in your {displayName} developer console, add the callback URL above as an authorized
                redirect URI, then copy the Client ID and Client Secret here.{' '}
                <a href={helpUrl} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                  Open the {displayName} developer console
                </a>.
              </p>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor={`${provider}-client-id`}>Client ID</Label>
              <Input id={`${provider}-client-id`} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${provider}-client-secret`}>Client Secret</Label>
              <Input
                id={`${provider}-client-secret`}
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={data?.clientSecretHint ?? 'Client secret'}
              />
            </div>
            {showSigningSecret ? (
              <div className="space-y-2">
                <Label htmlFor={`${provider}-signing-secret`}>Signing Secret</Label>
                <Input
                  id={`${provider}-signing-secret`}
                  type="password"
                  value={signingSecret}
                  onChange={(e) => setSigningSecret(e.target.value)}
                  placeholder={data?.signingSecretConfigured ? '••••••••' : 'Paste your signing secret'}
                />
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <Button onClick={onSave} disabled={save.isPending || !clientId}>Save credentials</Button>
              {data?.configured ? (
                <Button variant="ghost" className="text-destructive" onClick={onRemove} disabled={remove.isPending}>
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
