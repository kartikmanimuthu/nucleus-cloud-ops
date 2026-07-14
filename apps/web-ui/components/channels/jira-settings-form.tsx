'use client';

import { useState } from 'react';
import { useChannelSettings, useSaveChannelSettings, revealChannelSecrets } from '@/lib/queries/channel-settings';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Copy, ExternalLink, Eye, EyeOff, Loader2, PlugZap, RefreshCw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { SetupGuideLink } from '@/components/channels/setup-guide-link';

interface JiraSettingsForm {
    webhookSecret: string;
    baseUrl: string;
    userEmail: string;
    apiToken: string;
    botAccountId: string;
    enabled: boolean;
}

interface JiraSettingsFormProps {
    backHref?: string;
    backLabel?: string;
}

const EXAMPLE_PAYLOAD = {
    taskDescription: 'Check Lambda memory usage in prod',
    accountId: '123456789012',
    selectedSkill: 'aws-cost-optimization',
    issue: {
        key: 'OPS-42',
        fields: {
            summary: 'High Lambda costs detected',
            project: { key: 'OPS' },
            reporter: { displayName: 'Jane Doe' },
            issuetype: { name: 'Task' },
        },
    },
};

// Template using Jira Automation smart values — paste directly into the
// "Send web request" action's custom body so the payload fills itself per issue.
const SMART_VALUE_PAYLOAD = `{
  "taskDescription": "{{issue.summary}}",
  "issue": {
    "key": "{{issue.key}}",
    "fields": {
      "summary": "{{issue.summary}}",
      "project": { "key": "{{project.key}}" },
      "reporter": { "displayName": "{{issue.reporter.displayName}}" },
      "issuetype": { "name": "{{issue.issueType.name}}" }
    }
  }
}`;

export function JiraSettingsForm(props: JiraSettingsFormProps) {
    const { data, isLoading } = useChannelSettings('jira');
    if (isLoading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }
    return (
        <JiraSettingsFormInner
            {...props}
            initialConfigured={data?.configured ?? false}
            initialEnabled={data?.enabled ?? true}
            initialBaseUrl={(data?.baseUrl as string) || ''}
            initialUserEmail={(data?.userEmail as string) || ''}
            initialBotAccountId={(data?.botAccountId as string) || ''}
        />
    );
}

function JiraSettingsFormInner({
    backHref = '/agent-ops',
    backLabel = 'Back to Agent Ops',
    initialConfigured,
    initialEnabled,
    initialBaseUrl,
    initialUserEmail,
    initialBotAccountId,
}: JiraSettingsFormProps & {
    initialConfigured: boolean;
    initialEnabled: boolean;
    initialBaseUrl: string;
    initialUserEmail: string;
    initialBotAccountId: string;
}) {
    const router = useRouter();
    const saveMutation = useSaveChannelSettings('jira');
    const saving = saveMutation.isPending;
    const [configured, setConfigured] = useState(initialConfigured);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [showSecret, setShowSecret] = useState(false);
    const [showApiToken, setShowApiToken] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const [testing, setTesting] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);

    // Lazily pull the stored plaintext secrets into the form the first time the
    // user reveals a field (only when already configured and untouched).
    const revealSecrets = async () => {
        if (revealed || !configured) return;
        setRevealed(true);
        const data = await revealChannelSecrets('jira');
        setForm(prev => ({
            ...prev,
            webhookSecret: prev.webhookSecret || (data.webhookSecret as string) || '',
            apiToken: prev.apiToken || (data.apiToken as string) || '',
        }));
    };

    const [form, setForm] = useState<JiraSettingsForm>({
        webhookSecret: '',
        baseUrl: initialBaseUrl,
        userEmail: initialUserEmail,
        apiToken: '',
        botAccountId: initialBotAccountId,
        enabled: initialEnabled,
    });

    const webhookUrl =
        typeof window !== 'undefined'
            ? `${window.location.origin}/api/v1/trigger/jira`
            : '/api/v1/trigger/jira';

    const generateSecret = () => {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        const secret = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        setForm(prev => ({ ...prev, webhookSecret: secret }));
        setShowSecret(true);
        toast.success('Webhook secret generated — save it here, then use the same value in your Jira Automation rule header');
    };

    const handleSave = async () => {
        if (!configured && !form.webhookSecret.trim()) {
            setErrorMessage('Webhook Secret is required');
            setSaveStatus('error');
            return;
        }
        try {
            setErrorMessage('');
            await saveMutation.mutateAsync({
                webhookSecret: form.webhookSecret,
                baseUrl: form.baseUrl || undefined,
                userEmail: form.userEmail || undefined,
                apiToken: form.apiToken || undefined,
                botAccountId: form.botAccountId || undefined,
                enabled: form.enabled,
            });
            setConfigured(true);
            setSaveStatus('saved');
            setForm(prev => ({ ...prev, webhookSecret: '', apiToken: '' }));
            setRevealed(false);
            setShowSecret(false);
            setShowApiToken(false);
            setTimeout(() => setSaveStatus('idle'), 3000);
        } catch (error: any) {
            setErrorMessage(error.message || 'Failed to save');
            setSaveStatus('error');
        }
    };

    const handleTestConnection = async () => {
        setTesting(true);
        try {
            const res = await fetch('/api/agent-ops/settings/jira/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    baseUrl: form.baseUrl.trim() || undefined,
                    userEmail: form.userEmail.trim() || undefined,
                    apiToken: form.apiToken.trim() || undefined,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                toast.success(`Connected to Jira as ${data.data.displayName}`);
                if (!form.botAccountId.trim() && data.data.accountId) {
                    setForm(prev => ({ ...prev, botAccountId: data.data.accountId }));
                    toast.info('Bot Account ID auto-filled from the authenticated account — remember to save.');
                }
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
            {/* Back nav */}
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
                    <h1 className="text-2xl font-bold">Jira Integration</h1>
                    <p className="text-muted-foreground mt-1">
                        Trigger Agent Ops runs from Jira Automation rules and receive results as issue comments.
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
                href="/docs/jira-integration"
                description="Part 1 wires Jira → Agent Ops (trigger runs). Part 2 wires Agent Ops → Jira (result comments)."
            />

            {/* Webhook URL */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Webhook Endpoint</CardTitle>
                    <CardDescription>
                        Use this URL in your Jira Automation rule as the webhook destination.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="flex items-center gap-2">
                        <Input readOnly value={webhookUrl} className="font-mono text-sm" />
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={() => copyToClipboard(webhookUrl, 'webhook')}
                        >
                            {copied === 'webhook' ? (
                                <CheckCircle2 className="h-4 w-4 text-green-500" />
                            ) : (
                                <Copy className="h-4 w-4" />
                            )}
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Method: <code className="bg-muted px-1 rounded">POST</code> — Content-Type:{' '}
                        <code className="bg-muted px-1 rounded">application/json</code>
                    </p>
                </CardContent>
            </Card>

            {/* Credentials Form */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Credentials</CardTitle>
                    <CardDescription>
                        {configured
                            ? 'Enter new values to update stored credentials. Leave blank to keep existing values.'
                            : 'Configure your Jira integration credentials. These are stored securely for your organization.'}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    {/* Webhook Secret */}
                    <div className="space-y-2">
                        <Label htmlFor="webhookSecret">
                            Webhook Secret <span className="text-destructive">*</span>
                        </Label>
                        <div className="flex items-center gap-2">
                            <div className="relative flex-1">
                                <Input
                                    id="webhookSecret"
                                    type={showSecret ? 'text' : 'password'}
                                    placeholder={configured ? '••••••••••••' : 'Enter or generate a shared secret'}
                                    value={form.webhookSecret}
                                    onChange={e => setForm(prev => ({ ...prev, webhookSecret: e.target.value }))}
                                    className="pr-10 font-mono"
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                                    onClick={async () => {
                                        if (!showSecret) await revealSecrets();
                                        setShowSecret(v => !v);
                                    }}
                                >
                                    {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                </Button>
                            </div>
                            <Button type="button" variant="outline" size="sm" onClick={generateSecret}>
                                <RefreshCw className="h-3.5 w-3.5 mr-2" />
                                Generate
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            A shared secret that authenticates incoming webhooks. Click{' '}
                            <strong>Generate</strong> to create a strong one, then use the <em>same value</em> as the{' '}
                            <code className="bg-muted px-1 rounded">Authorization: Bearer &lt;secret&gt;</code> header in
                            your Jira Automation rule.
                        </p>
                    </div>

                    {/* Base URL */}
                    <div className="space-y-2">
                        <Label htmlFor="baseUrl">
                            Jira Base URL{' '}
                            <span className="text-muted-foreground text-xs">(required to post results back)</span>
                        </Label>
                        <Input
                            id="baseUrl"
                            type="url"
                            placeholder="https://your-org.atlassian.net"
                            value={form.baseUrl}
                            onChange={e => setForm(prev => ({ ...prev, baseUrl: e.target.value }))}
                            className="font-mono text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                            Your Jira Cloud site URL — the part before <code className="bg-muted px-1 rounded">/browse/…</code>{' '}
                            when viewing any issue. Needed to post run results back to issues as comments.
                        </p>
                    </div>

                    {/* User Email */}
                    <div className="space-y-2">
                        <Label htmlFor="userEmail">
                            User Email{' '}
                            <span className="text-muted-foreground text-xs">(required to post results back)</span>
                        </Label>
                        <Input
                            id="userEmail"
                            type="email"
                            placeholder="bot@your-org.com"
                            value={form.userEmail}
                            onChange={e => setForm(prev => ({ ...prev, userEmail: e.target.value }))}
                        />
                        <p className="text-xs text-muted-foreground">
                            Email of the Atlassian account that owns the API token below. Comments will appear as this
                            user — a dedicated bot/service account is recommended.
                        </p>
                    </div>

                    {/* API Token */}
                    <div className="space-y-2">
                        <Label htmlFor="apiToken">
                            API Token{' '}
                            <span className="text-muted-foreground text-xs">(required to post results back)</span>
                        </Label>
                        <div className="relative">
                            <Input
                                id="apiToken"
                                type={showApiToken ? 'text' : 'password'}
                                placeholder={configured ? '••••••••••••' : 'ATATT3x...'}
                                value={form.apiToken}
                                onChange={e => setForm(prev => ({ ...prev, apiToken: e.target.value }))}
                                className="pr-10 font-mono"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                                onClick={async () => {
                                    if (!showApiToken) await revealSecrets();
                                    setShowApiToken(v => !v);
                                }}
                            >
                                {showApiToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Sign in as the account above, then create a token at{' '}
                            <a
                                href="https://id.atlassian.com/manage-profile/security/api-tokens"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-blue-500 hover:underline"
                            >
                                id.atlassian.com → Security → API tokens
                                <ExternalLink className="h-3 w-3" />
                            </a>{' '}
                            → <strong>Create API token</strong>. Copy it immediately — Atlassian shows it only once.
                        </p>
                    </div>

                    {/* Bot Account ID */}
                    <div className="space-y-2">
                        <Label htmlFor="botAccountId">
                            Bot Account ID <span className="text-muted-foreground text-xs">(optional)</span>
                        </Label>
                        <Input
                            id="botAccountId"
                            type="text"
                            placeholder="5b10a2844c20165700ede21g"
                            value={form.botAccountId}
                            onChange={e => setForm(prev => ({ ...prev, botAccountId: e.target.value }))}
                            className="font-mono text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                            Jira account ID of the bot user. Used to detect <code className="bg-muted px-1 rounded">@bot</code> mentions
                            and prevent the bot from triggering itself on its own comments. Easiest way to fill it: enter
                            the credentials above and click <strong>Test Connection</strong> — it is detected
                            automatically. (Manual: open the bot user&apos;s profile in Jira; the ID is the last part of
                            the profile URL after <code className="bg-muted px-1 rounded">/people/</code>.)
                        </p>
                    </div>

                    {/* Enable toggle */}
                    <div className="flex items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                            <Label htmlFor="jira-enabled" className="text-sm font-medium">Enable Jira Integration</Label>
                            <p className="text-xs text-muted-foreground">
                                When disabled, incoming Jira webhook requests will be rejected.
                            </p>
                        </div>
                        <Switch
                            id="jira-enabled"
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
                            disabled={
                                saving ||
                                testing ||
                                (!configured && !(form.baseUrl.trim() && form.userEmail.trim() && form.apiToken.trim()))
                            }
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
                        Test Connection verifies Base URL, User Email, and API Token against Jira and auto-fills the Bot
                        Account ID on success.
                    </p>
                </CardContent>
            </Card>

            {/* Payload Schema */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Webhook Payload</CardTitle>
                    <CardDescription>
                        JSON body to send from your Jira Automation rule. All fields except{' '}
                        <code className="bg-muted px-1 rounded">taskDescription</code> are optional.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <p className="text-sm font-medium text-foreground">
                            Automation template{' '}
                            <span className="text-xs font-normal text-muted-foreground">
                                — uses Jira smart values; paste as-is into the &quot;Send web request&quot; custom body
                            </span>
                        </p>
                        <pre className="bg-muted rounded-md p-4 text-xs overflow-x-auto">{SMART_VALUE_PAYLOAD}</pre>
                        <Button variant="outline" size="sm" onClick={() => copyToClipboard(SMART_VALUE_PAYLOAD, 'smart')}>
                            {copied === 'smart' ? (
                                <CheckCircle2 className="h-4 w-4 mr-2 text-green-500" />
                            ) : (
                                <Copy className="h-4 w-4 mr-2" />
                            )}
                            Copy automation template
                        </Button>
                    </div>
                    <div className="space-y-2">
                        <p className="text-sm font-medium text-foreground">
                            Example resolved payload{' '}
                            <span className="text-xs font-normal text-muted-foreground">
                                — what the webhook receives; useful for testing with curl
                            </span>
                        </p>
                        <pre className="bg-muted rounded-md p-4 text-xs overflow-x-auto">
                            {JSON.stringify(EXAMPLE_PAYLOAD, null, 2)}
                        </pre>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyToClipboard(JSON.stringify(EXAMPLE_PAYLOAD, null, 2), 'payload')}
                        >
                            {copied === 'payload' ? (
                                <CheckCircle2 className="h-4 w-4 mr-2 text-green-500" />
                            ) : (
                                <Copy className="h-4 w-4 mr-2" />
                            )}
                            Copy example payload
                        </Button>
                    </div>
                </CardContent>
            </Card>

        </div>
    );
}
