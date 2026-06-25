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

interface WebhookSettingsState {
    webhookSecret: string;
    enabled: boolean;
}

interface WebhookSettingsFormProps {
    backHref?: string;
    backLabel?: string;
}

const EXAMPLE_PAYLOAD = `{
  "taskDescription": "Check Lambda configurations",
  "tenantId": "your-tenant-id",
  "callbackUrl": "https://your-system.com/callback",
  "mode": "fast",
  "autoApprove": false
}`;

export function WebhookSettingsForm({ backHref = '/agent-ops', backLabel = 'Back to Agent Ops' }: WebhookSettingsFormProps) {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [configured, setConfigured] = useState(false);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [showSecret, setShowSecret] = useState(false);
    const [copiedEndpoint, setCopiedEndpoint] = useState(false);
    const [copiedPayload, setCopiedPayload] = useState(false);

    const [form, setForm] = useState<WebhookSettingsState>({
        webhookSecret: '',
        enabled: true,
    });

    const gatewayUrl =
        typeof window !== 'undefined'
            ? `${window.location.origin}/api/v1/gateway/webhook`
            : '/api/v1/gateway/webhook';

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/agent-ops/settings/webhook');
            const data = await res.json();
            setConfigured(data.configured ?? false);
            setForm(prev => ({ ...prev, enabled: data.enabled ?? true }));
        } catch (error) {
            console.error('[WebhookSettings] Failed to fetch settings:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        if (!form.webhookSecret.trim()) {
            setErrorMessage('Webhook Secret is required');
            setSaveStatus('error');
            return;
        }
        try {
            setSaving(true);
            setErrorMessage('');
            const res = await fetch('/api/agent-ops/settings/webhook', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    webhookSecret: form.webhookSecret,
                    enabled: form.enabled,
                }),
            });
            const data = await res.json();
            if (res.ok) {
                setConfigured(true);
                setSaveStatus('saved');
                setForm(prev => ({ ...prev, webhookSecret: '' }));
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

    const copyToClipboard = (text: string, setter: (v: boolean) => void) => {
        navigator.clipboard.writeText(text);
        setter(true);
        setTimeout(() => setter(false), 2000);
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
                    <h1 className="text-2xl font-bold">Generic Webhook Integration</h1>
                    <p className="text-muted-foreground mt-1">
                        Configure a webhook endpoint to trigger Agent Ops runs from any external system.
                    </p>
                </div>
                {configured && (
                    <Badge variant="secondary" className="gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        Configured
                    </Badge>
                )}
            </div>

            {/* Gateway Endpoint URL */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Gateway Endpoint URL</CardTitle>
                    <CardDescription>
                        POST requests to this URL to trigger Agent Ops runs.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center gap-2">
                        <Input readOnly value={gatewayUrl} className="font-mono text-sm" />
                        <Button variant="outline" size="icon" onClick={() => copyToClipboard(gatewayUrl, setCopiedEndpoint)}>
                            {copiedEndpoint ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
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
                            ? 'Enter a new value to update the stored secret. Leave blank to keep the existing value.'
                            : 'Enter your webhook secret. It is encrypted and stored securely.'}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    {/* Webhook Secret */}
                    <div className="space-y-2">
                        <Label htmlFor="webhookSecret">
                            Webhook Secret <span className="text-destructive">*</span>
                        </Label>
                        <div className="relative">
                            <Input
                                id="webhookSecret"
                                type={showSecret ? 'text' : 'password'}
                                placeholder={configured ? '••••••••••••' : 'Enter webhook secret'}
                                value={form.webhookSecret}
                                onChange={e => setForm(prev => ({ ...prev, webhookSecret: e.target.value }))}
                                className="pr-10 font-mono"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                                onClick={() => setShowSecret(v => !v)}
                            >
                                {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Used to compute HMAC-SHA256 signature for request verification.
                        </p>
                    </div>

                    {/* Enable toggle */}
                    <div className="flex items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                            <Label htmlFor="webhook-enabled" className="text-sm font-medium">Enable Webhook Integration</Label>
                            <p className="text-xs text-muted-foreground">
                                When disabled, incoming webhook requests will be rejected.
                            </p>
                        </div>
                        <Switch
                            id="webhook-enabled"
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

            {/* Request Format */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Request Format</CardTitle>
                    <CardDescription>
                        Send a JSON payload with the following structure.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="relative">
                        <pre className="bg-muted rounded-lg p-4 text-sm font-mono overflow-x-auto">
                            <code>{EXAMPLE_PAYLOAD}</code>
                        </pre>
                        <Button
                            variant="outline"
                            size="icon"
                            className="absolute top-2 right-2 h-7 w-7"
                            onClick={() => copyToClipboard(EXAMPLE_PAYLOAD, setCopiedPayload)}
                        >
                            {copiedPayload ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* Authentication */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Authentication</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                    <p>
                        Every request must include an <code className="bg-muted px-1 rounded text-foreground">x-webhook-signature</code> header
                        containing the HMAC-SHA256 hex digest of the raw request body, computed using your webhook secret.
                    </p>
                    <pre className="bg-muted rounded-lg p-4 text-xs font-mono overflow-x-auto">
                        <code>{`signature = HMAC-SHA256(webhookSecret, requestBody)
Header: x-webhook-signature: <hex digest>`}</code>
                    </pre>
                </CardContent>
            </Card>

            {/* Setup Guide */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Setup Guide</CardTitle>
                </CardHeader>
                <CardContent>
                    <ol className="space-y-3 text-sm text-muted-foreground list-decimal list-inside">
                        <li>Generate a random webhook secret and enter it above.</li>
                        <li>Configure your external system to <code className="bg-muted px-1 rounded text-foreground">POST</code> to the Gateway Endpoint URL shown above.</li>
                        <li>
                            Sign each request: compute HMAC-SHA256 of the raw request body using the secret, and send it as the{' '}
                            <code className="bg-muted px-1 rounded text-foreground">x-webhook-signature</code> header.
                        </li>
                        <li>
                            Include a <code className="bg-muted px-1 rounded text-foreground">callbackUrl</code> in the payload to receive results asynchronously.
                        </li>
                        <li>
                            Results will be POSTed to your callback URL with{' '}
                            <code className="bg-muted px-1 rounded text-foreground">{'{ runId, status, summary, toolsUsed, duration }'}</code>.
                        </li>
                    </ol>
                </CardContent>
            </Card>
        </div>
    );
}
