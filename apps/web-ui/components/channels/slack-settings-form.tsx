'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChannelSettings, useSaveChannelSettings, revealChannelSecrets } from '@/lib/queries/channel-settings';
import { ArrowLeft, CheckCircle2, Copy, Eye, EyeOff, Loader2, PlugZap, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { SetupGuideLink } from '@/components/channels/setup-guide-link';
import { ChannelResetCard } from '@/components/channels/channel-reset-card';

interface SlackSettingsState {
    signingSecret: string;
    botToken: string;
    teamId: string;
    enabled: boolean;
}

interface SlackSettingsFormProps {
    backHref?: string;
    backLabel?: string;
}

export function SlackSettingsForm(props: SlackSettingsFormProps) {
    const { data, isLoading } = useChannelSettings('slack');
    if (isLoading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }
    return (
        <SlackSettingsFormInner
            {...props}
            initialConfigured={data?.configured ?? false}
            initialEnabled={data?.enabled ?? true}
            initialTeamId={(data?.teamId as string | null) ?? ''}
        />
    );
}

function SlackSettingsFormInner({
    backHref = '/agent-ops',
    backLabel = 'Back to Agent Ops',
    initialConfigured,
    initialEnabled,
    initialTeamId,
}: SlackSettingsFormProps & { initialConfigured: boolean; initialEnabled: boolean; initialTeamId: string }) {
    const router = useRouter();
    const saveMutation = useSaveChannelSettings('slack');
    const saving = saveMutation.isPending;
    const [configured, setConfigured] = useState(initialConfigured);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [showSigningSecret, setShowSigningSecret] = useState(false);
    const [showBotToken, setShowBotToken] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const [testing, setTesting] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);

    // Lazily pull the stored plaintext secrets into the form the first time the
    // user reveals a field (only when already configured and untouched).
    const revealSecrets = async () => {
        if (revealed || !configured) return;
        setRevealed(true);
        const data = await revealChannelSecrets('slack');
        setForm(prev => ({
            ...prev,
            signingSecret: prev.signingSecret || (data.signingSecret as string) || '',
            botToken: prev.botToken || (data.botToken as string) || '',
        }));
    };

    const [form, setForm] = useState<SlackSettingsState>({
        signingSecret: '',
        botToken: '',
        teamId: initialTeamId,
        enabled: initialEnabled,
    });

    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const webhookUrl = `${origin}/api/v1/trigger/slack`;
    const interactionsUrl = `${origin}/api/v1/gateway/slack/interactions`;

    // App manifest pre-wires the slash command, bot scopes, and interactivity
    // endpoint so "Create app → From a manifest" needs zero manual configuration.
    const appManifest = JSON.stringify(
        {
            display_information: {
                name: 'Nucleus Cloud Ops',
                description: 'AI Ops agent — trigger cloud operations tasks and receive results in Slack',
            },
            features: {
                bot_user: { display_name: 'nucleus-cloud-ops', always_online: true },
                slash_commands: [
                    {
                        command: '/cloud-ops',
                        url: webhookUrl,
                        description: 'Run an Agent Ops task',
                        usage_hint: 'check EC2 costs in prod',
                        should_escape: false,
                    },
                ],
            },
            oauth_config: {
                scopes: { bot: ['commands', 'chat:write', 'chat:write.public'] },
            },
            settings: {
                interactivity: { is_enabled: true, request_url: interactionsUrl },
                org_deploy_enabled: false,
                socket_mode_enabled: false,
                token_rotation_enabled: false,
            },
        },
        null,
        2
    );

    const handleSave = async () => {
        if (!configured && !form.signingSecret.trim()) {
            setErrorMessage('Signing Secret is required');
            setSaveStatus('error');
            return;
        }
        if (!configured && !form.botToken.trim() && !form.teamId.trim()) {
            setErrorMessage('Enter a Bot Token, or a Slack Workspace/Team ID if you\'re not using one');
            setSaveStatus('error');
            return;
        }
        try {
            setErrorMessage('');
            const result = await saveMutation.mutateAsync({
                signingSecret: form.signingSecret,
                botToken: form.botToken || undefined,
                teamId: form.teamId.trim() || undefined,
                enabled: form.enabled,
            });
            setConfigured(true);
            setSaveStatus('saved');
            setForm(prev => ({ ...prev, signingSecret: '', botToken: '', teamId: (result.teamId as string) || prev.teamId }));
            setRevealed(false);
            setShowSigningSecret(false);
            setShowBotToken(false);
            setTimeout(() => setSaveStatus('idle'), 3000);
        } catch (error: any) {
            setErrorMessage(error.message || 'Failed to save');
            setSaveStatus('error');
        }
    };

    const handleTestConnection = async () => {
        setTesting(true);
        try {
            const res = await fetch('/api/agent-ops/settings/slack/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ botToken: form.botToken.trim() || undefined }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                toast.success(`Connected to workspace "${data.data.team}" as @${data.data.botUser}`);
            } else {
                toast.error(data.error || 'Connection test failed');
            }
        } catch {
            toast.error('Connection test failed — network error');
        } finally {
            setTesting(false);
        }
    };

    const copyToClipboard = (text: string, key: string) => {
        navigator.clipboard.writeText(text);
        setCopied(key);
        setTimeout(() => setCopied(null), 2000);
    };

    return (
        <div className="flex-1 bg-background max-w-3xl mx-auto space-y-6">
            <div>
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2 text-muted-foreground hover:text-foreground -ml-2"
                    onClick={() => router.push(backHref)}
                >
                    <ArrowLeft className="h-4 w-4" />
                    {backLabel}
                </Button>
            </div>

            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Slack Integration</h1>
                    <p className="text-muted-foreground mt-1">
                        Trigger Agent Ops runs via slash commands and receive results, scheduled digests, and approval
                        requests in your channels.
                    </p>
                </div>
                {configured && (
                    <Badge variant="secondary" className="gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        Configured
                    </Badge>
                )}
            </div>

            {/* Setup Guide */}
            <SetupGuideLink
                href="/docs/slack-integration"
                description="From zero to a working Slack integration in about five minutes."
            />

            {/* Webhook URL */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Slash Command URL</CardTitle>
                    <CardDescription>
                        Use this URL when creating your Slack app slash command.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center gap-2">
                        <Input readOnly value={webhookUrl} className="font-mono text-sm" />
                        <Button variant="outline" size="icon" onClick={() => copyToClipboard(webhookUrl, 'webhook')}>
                            {copied === 'webhook' ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                        Method: <code className="bg-muted px-1 rounded">POST</code>
                    </p>
                </CardContent>
            </Card>

            {/* Credentials Form */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Credentials</CardTitle>
                    <CardDescription>
                        {configured
                            ? 'Enter new values to update the stored credentials. Leave blank to keep existing values.'
                            : 'Enter your Slack app credentials. These are stored securely for your organization.'}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    {/* Signing Secret */}
                    <div className="space-y-2">
                        <Label htmlFor="signingSecret">
                            Signing Secret <span className="text-destructive">*</span>
                        </Label>
                        <div className="relative">
                            <Input
                                id="signingSecret"
                                type={showSigningSecret ? 'text' : 'password'}
                                placeholder={configured ? '••••••••••••' : 'Enter signing secret'}
                                value={form.signingSecret}
                                onChange={e => setForm(prev => ({ ...prev, signingSecret: e.target.value }))}
                                className="pr-10 font-mono"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                                onClick={async () => {
                                    if (!showSigningSecret) await revealSecrets();
                                    setShowSigningSecret(v => !v);
                                }}
                            >
                                {showSigningSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Verifies that incoming requests really come from Slack. Found in your Slack app under{' '}
                            <strong>Basic Information → App Credentials → Signing Secret</strong>.
                        </p>
                    </div>

                    {/* Bot Token */}
                    <div className="space-y-2">
                        <Label htmlFor="botToken">
                            Bot Token <span className="text-muted-foreground text-xs">(recommended)</span>
                        </Label>
                        <div className="relative">
                            <Input
                                id="botToken"
                                type={showBotToken ? 'text' : 'password'}
                                placeholder={configured ? '••••••••••••' : 'xoxb-...'}
                                value={form.botToken}
                                onChange={e => setForm(prev => ({ ...prev, botToken: e.target.value }))}
                                className="pr-10 font-mono"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                                onClick={async () => {
                                    if (!showBotToken) await revealSecrets();
                                    setShowBotToken(v => !v);
                                }}
                            >
                                {showBotToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Needed to post run results, scheduled-task digests, and approval buttons back to Slack
                            (requires the <code className="bg-muted px-1 rounded">chat:write</code> scope). After
                            installing the app, copy it from <strong>OAuth &amp; Permissions → Bot User OAuth Token</strong>{' '}
                            (starts with <code className="bg-muted px-1 rounded">xoxb-</code>). Without it, only
                            ephemeral replies to slash commands work.
                        </p>
                    </div>

                    {/* Slack Workspace / Team ID — only needed when there's no Bot Token */}
                    {!form.botToken.trim() && (
                        <div className="space-y-2">
                            <Label htmlFor="teamId">
                                Slack Workspace/Team ID{' '}
                                <span className="text-destructive">*</span>
                            </Label>
                            <Input
                                id="teamId"
                                placeholder="T0123ABCDEF"
                                value={form.teamId}
                                onChange={e => setForm(prev => ({ ...prev, teamId: e.target.value }))}
                                className="font-mono"
                            />
                            <p className="text-xs text-muted-foreground">
                                Used to route incoming slash commands to your organization. Found in your Slack
                                workspace URL (<code className="bg-muted px-1 rounded">app.slack.com/client/T0123.../...</code>)
                                or under <strong>Settings &amp; administration → About this workspace</strong>. Not
                                needed if a Bot Token is set above — it&apos;s derived automatically.
                            </p>
                        </div>
                    )}

                    {/* Enable toggle */}
                    <div className="flex items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                            <Label htmlFor="slack-enabled" className="text-sm font-medium">Enable Slack Integration</Label>
                            <p className="text-xs text-muted-foreground">
                                When disabled, incoming Slack slash commands will be rejected.
                            </p>
                        </div>
                        <Switch
                            id="slack-enabled"
                            checked={form.enabled}
                            onCheckedChange={checked => setForm(prev => ({ ...prev, enabled: checked }))}
                        />
                    </div>

                    {/* Error */}
                    {saveStatus === 'error' && errorMessage && (
                        <Alert variant="destructive">
                            <AlertDescription>{errorMessage}</AlertDescription>
                        </Alert>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                        <Button
                            onClick={handleSave}
                            disabled={saving || testing}
                            className={saveStatus === 'saved' ? 'bg-green-600 hover:bg-green-700' : ''}
                        >
                            {saving ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : saveStatus === 'saved' ? (
                                <CheckCircle2 className="h-4 w-4 mr-2" />
                            ) : (
                                <Save className="h-4 w-4 mr-2" />
                            )}
                            {saveStatus === 'saved' ? 'Saved' : 'Save Settings'}
                        </Button>
                        <Button
                            variant="outline"
                            onClick={handleTestConnection}
                            disabled={saving || testing || (!configured && !form.botToken.trim())}
                        >
                            {testing ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                                <PlugZap className="h-4 w-4 mr-2" />
                            )}
                            Test Connection
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Test Connection verifies the Bot Token against Slack&apos;s{' '}
                        <code className="bg-muted px-1 rounded">auth.test</code> API — enter a token above or save one
                        first.
                    </p>
                </CardContent>
            </Card>

            {/* App Manifest */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">App Manifest — quick create</CardTitle>
                    <CardDescription>
                        The fastest way to set up: create your Slack app <strong>from this manifest</strong> and the
                        slash command, bot scopes, and interactivity endpoint are configured automatically.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <pre className="bg-muted rounded-md p-4 text-xs overflow-x-auto max-h-64">{appManifest}</pre>
                    <Button variant="outline" size="sm" onClick={() => copyToClipboard(appManifest, 'manifest')}>
                        {copied === 'manifest' ? (
                            <CheckCircle2 className="h-4 w-4 mr-2 text-green-500" />
                        ) : (
                            <Copy className="h-4 w-4 mr-2" />
                        )}
                        Copy app manifest
                    </Button>
                </CardContent>
            </Card>

            <ChannelResetCard
                channel="slack"
                name="Slack"
                clears="signing secret, bot token and workspace link"
                configured={configured}
                onReset={() => {
                    setConfigured(false);
                    setRevealed(false);
                    setSaveStatus('idle');
                    setForm({ signingSecret: '', botToken: '', teamId: '', enabled: true });
                }}
            />
        </div>
    );
}
