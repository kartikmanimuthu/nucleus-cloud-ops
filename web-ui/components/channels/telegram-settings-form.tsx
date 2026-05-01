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

interface TelegramSettingsState {
    botToken: string;
    secretToken: string;
    enabled: boolean;
}

interface TelegramSettingsFormProps {
    backHref?: string;
    backLabel?: string;
}

export function TelegramSettingsForm({ backHref = '/agent-ops', backLabel = 'Back to Agent Ops' }: TelegramSettingsFormProps) {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [configured, setConfigured] = useState(false);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [showBotToken, setShowBotToken] = useState(false);
    const [showSecretToken, setShowSecretToken] = useState(false);
    const [copied, setCopied] = useState(false);

    const [form, setForm] = useState<TelegramSettingsState>({
        botToken: '',
        secretToken: '',
        enabled: true,
    });

    const webhookUrl =
        typeof window !== 'undefined'
            ? `${window.location.origin}/api/v1/gateway/telegram`
            : '/api/v1/gateway/telegram';

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/agent-ops/settings/telegram');
            const data = await res.json();
            setConfigured(data.configured ?? false);
            setForm(prev => ({ ...prev, enabled: data.enabled ?? true }));
        } catch (error) {
            console.error('[TelegramSettings] Failed to fetch settings:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        if (!form.botToken.trim()) {
            setErrorMessage('Bot Token is required');
            setSaveStatus('error');
            return;
        }
        if (!form.secretToken.trim()) {
            setErrorMessage('Secret Token is required');
            setSaveStatus('error');
            return;
        }
        try {
            setSaving(true);
            setErrorMessage('');
            const res = await fetch('/api/agent-ops/settings/telegram', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    botToken: form.botToken,
                    secretToken: form.secretToken,
                    enabled: form.enabled,
                }),
            });
            const data = await res.json();
            if (res.ok) {
                setConfigured(true);
                setSaveStatus('saved');
                setForm(prev => ({ ...prev, botToken: '', secretToken: '' }));
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
                    <h1 className="text-2xl font-bold">Telegram Integration</h1>
                    <p className="text-muted-foreground mt-1">
                        Configure your Telegram bot to trigger Agent Ops runs via messages.
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
                    <CardTitle className="text-base">Webhook URL</CardTitle>
                    <CardDescription>
                        Use this URL when setting up the Telegram bot webhook.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center gap-2">
                        <Input readOnly value={webhookUrl} className="font-mono text-sm" />
                        <Button variant="outline" size="icon" onClick={() => copyToClipboard(webhookUrl)}>
                            {copied ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
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
                            : 'Enter your Telegram bot credentials. These are encrypted and stored securely.'}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    {/* Bot Token */}
                    <div className="space-y-2">
                        <Label htmlFor="botToken">
                            Bot Token <span className="text-destructive">*</span>
                        </Label>
                        <div className="relative">
                            <Input
                                id="botToken"
                                type={showBotToken ? 'text' : 'password'}
                                placeholder={configured ? '••••••••••••' : 'Enter bot token'}
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
                            Get this from <strong>@BotFather</strong> on Telegram.
                        </p>
                    </div>

                    {/* Secret Token */}
                    <div className="space-y-2">
                        <Label htmlFor="secretToken">
                            Secret Token <span className="text-destructive">*</span>
                        </Label>
                        <div className="relative">
                            <Input
                                id="secretToken"
                                type={showSecretToken ? 'text' : 'password'}
                                placeholder={configured ? '••••••••••••' : 'Enter secret token'}
                                value={form.secretToken}
                                onChange={e => setForm(prev => ({ ...prev, secretToken: e.target.value }))}
                                className="pr-10 font-mono"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                                onClick={() => setShowSecretToken(v => !v)}
                            >
                                {showSecretToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Used to verify webhook requests. Choose any random string.
                        </p>
                    </div>

                    {/* Enable toggle */}
                    <div className="flex items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                            <Label htmlFor="telegram-enabled" className="text-sm font-medium">Enable Telegram Integration</Label>
                            <p className="text-xs text-muted-foreground">
                                When disabled, incoming Telegram messages will be rejected.
                            </p>
                        </div>
                        <Switch
                            id="telegram-enabled"
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
                            Open Telegram and message <strong className="text-foreground">@BotFather</strong>.
                        </li>
                        <li>
                            Send <code className="bg-muted px-1 rounded text-foreground">/newbot</code> and follow the prompts to create a bot.
                        </li>
                        <li>Copy the <strong className="text-foreground">Bot Token</strong> provided by BotFather and paste it above.</li>
                        <li>Choose a <strong className="text-foreground">Secret Token</strong> (any random string) for webhook verification and enter it above.</li>
                        <li>
                            Set the webhook URL by calling:{' '}
                            <code className="bg-muted px-1 rounded text-foreground text-xs break-all">
                                https://api.telegram.org/bot&#123;YOUR_TOKEN&#125;/setWebhook?url=&#123;WEBHOOK_URL&#125;&secret_token=&#123;SECRET_TOKEN&#125;
                            </code>
                        </li>
                        <li>
                            Test by sending <code className="bg-muted px-1 rounded text-foreground">/cloudops Check Lambda configs</code> to your bot.
                        </li>
                    </ol>
                </CardContent>
            </Card>
        </div>
    );
}
