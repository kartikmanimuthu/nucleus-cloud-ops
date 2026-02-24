'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Copy, Eye, EyeOff, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';

interface SlackSettingsState {
    signingSecret: string;
    botToken: string;
    enabled: boolean;
}

export default function SlackSettingsPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [configured, setConfigured] = useState(false);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [showSigningSecret, setShowSigningSecret] = useState(false);
    const [showBotToken, setShowBotToken] = useState(false);
    const [copied, setCopied] = useState(false);

    const [form, setForm] = useState<SlackSettingsState>({
        signingSecret: '',
        botToken: '',
        enabled: true,
    });

    const webhookUrl =
        typeof window !== 'undefined'
            ? `${window.location.origin}/api/v1/trigger/slack`
            : '/api/v1/trigger/slack';

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/agent-ops/settings/slack');
            const data = await res.json();
            setConfigured(data.configured ?? false);
            setForm(prev => ({ ...prev, enabled: data.enabled ?? true }));
        } catch (error) {
            console.error('[SlackSettings] Failed to fetch settings:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        if (!form.signingSecret.trim()) {
            setErrorMessage('Signing Secret is required');
            setSaveStatus('error');
            return;
        }

        try {
            setSaving(true);
            setErrorMessage('');

            const res = await fetch('/api/agent-ops/settings/slack', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    signingSecret: form.signingSecret,
                    botToken: form.botToken || undefined,
                    enabled: form.enabled,
                }),
            });

            const data = await res.json();

            if (res.ok) {
                setConfigured(true);
                setSaveStatus('saved');
                setForm(prev => ({ ...prev, signingSecret: '', botToken: '' }));
                setTimeout(() => setSaveStatus('idle'), 3000);
            } else {
                setErrorMessage(data.error || 'Failed to save');
                setSaveStatus('error');
            }
        } catch (error: any) {
            setErrorMessage(error.message || 'Failed to save');
            setSaveStatus('error');
        } finally {
            setSaving(false);
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="flex-1 p-4 md:p-8 pt-6 bg-background max-w-3xl mx-auto space-y-6">
            {/* Back nav */}
            <div>
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2 text-muted-foreground hover:text-foreground -ml-2"
                    onClick={() => router.push('/agent-ops')}
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back to Agent Ops
                </Button>
            </div>

            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Slack Integration</h1>
                    <p className="text-muted-foreground mt-1">
                        Configure your Slack app to trigger Agent Ops runs via slash commands.
                    </p>
                </div>
                {configured && (
                    <Badge variant="secondary" className="gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        Configured
                    </Badge>
                )}
            </div>

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
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={() => copyToClipboard(webhookUrl)}
                        >
                            {copied ? (
                                <CheckCircle2 className="h-4 w-4 text-green-500" />
                            ) : (
                                <Copy className="h-4 w-4" />
                            )}
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
                            : 'Enter your Slack app credentials. These are encrypted and stored securely.'}
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
                                onClick={() => setShowSigningSecret(v => !v)}
                            >
                                {showSigningSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Found in your Slack app under <strong>Basic Information → App Credentials</strong>.
                        </p>
                    </div>

                    {/* Bot Token */}
                    <div className="space-y-2">
                        <Label htmlFor="botToken">
                            Bot Token <span className="text-muted-foreground text-xs">(optional)</span>
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
                                onClick={() => setShowBotToken(v => !v)}
                            >
                                {showBotToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Required only for proactive messages. Found under <strong>OAuth & Permissions → Bot User OAuth Token</strong>.
                        </p>
                    </div>

                    {/* Enable toggle */}
                    <div className="flex items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                            <Label htmlFor="enabled" className="text-sm font-medium">Enable Slack Integration</Label>
                            <p className="text-xs text-muted-foreground">
                                When disabled, incoming Slack slash commands will be rejected.
                            </p>
                        </div>
                        <Switch
                            id="enabled"
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

                    {/* Save button */}
                    <Button
                        onClick={handleSave}
                        disabled={saving}
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
                </CardContent>
            </Card>

            {/* Setup Guide */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Setup Guide</CardTitle>
                </CardHeader>
                <CardContent>
                    <ol className="space-y-3 text-sm text-muted-foreground list-decimal list-inside">
                        <li>
                            Go to <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">api.slack.com/apps</a> and create a new app.
                        </li>
                        <li>Under <strong className="text-foreground">Basic Information</strong>, copy the <strong className="text-foreground">Signing Secret</strong> and paste it above.</li>
                        <li>
                            Under <strong className="text-foreground">Slash Commands</strong>, create a new command (e.g. <code className="bg-muted px-1 rounded text-foreground">/cloud-ops</code>).
                        </li>
                        <li>Set the <strong className="text-foreground">Request URL</strong> to the Slash Command URL shown above.</li>
                        <li>Install the app to your workspace and test the slash command.</li>
                    </ol>
                </CardContent>
            </Card>
        </div>
    );
}
