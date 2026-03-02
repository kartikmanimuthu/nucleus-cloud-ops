'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Copy, ExternalLink, Eye, EyeOff, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';

interface JiraSettingsForm {
    webhookSecret: string;
    baseUrl: string;
    userEmail: string;
    apiToken: string;
    enabled: boolean;
}

export default function JiraSettingsPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [configured, setConfigured] = useState(false);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [showSecret, setShowSecret] = useState(false);
    const [showApiToken, setShowApiToken] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);

    const [form, setForm] = useState<JiraSettingsForm>({
        webhookSecret: '',
        baseUrl: '',
        userEmail: '',
        apiToken: '',
        enabled: true,
    });

    const webhookUrl =
        typeof window !== 'undefined'
            ? `${window.location.origin}/api/v1/trigger/jira`
            : '/api/v1/trigger/jira';

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/agent-ops/settings/jira');
            const data = await res.json();
            setConfigured(data.configured ?? false);
            setForm(prev => ({
                ...prev,
                enabled: data.enabled ?? true,
                baseUrl: data.baseUrl || '',
                userEmail: data.userEmail || '',
            }));
        } catch (error) {
            console.error('[JiraSettings] Failed to fetch settings:', error);
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

            const res = await fetch('/api/agent-ops/settings/jira', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    webhookSecret: form.webhookSecret,
                    baseUrl: form.baseUrl || undefined,
                    userEmail: form.userEmail || undefined,
                    apiToken: form.apiToken || undefined,
                    enabled: form.enabled,
                }),
            });

            const data = await res.json();

            if (res.ok) {
                setConfigured(true);
                setSaveStatus('saved');
                // Clear secret fields; keep non-secret fields for display
                setForm(prev => ({ ...prev, webhookSecret: '', apiToken: '' }));
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

    const copyToClipboard = (text: string, key: string) => {
        navigator.clipboard.writeText(text);
        setCopied(key);
        setTimeout(() => setCopied(null), 2000);
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
                            : 'Configure your Jira integration credentials. These are stored securely in DynamoDB.'}
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
                                placeholder={configured ? '••••••••••••' : 'Enter shared secret'}
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
                            A secret you generate and then set as a custom header in your Jira Automation rule.
                        </p>
                    </div>

                    {/* Base URL */}
                    <div className="space-y-2">
                        <Label htmlFor="baseUrl">
                            Jira Base URL <span className="text-muted-foreground text-xs">(optional)</span>
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
                            Required to post run results back to Jira issues as comments.
                        </p>
                    </div>

                    {/* User Email */}
                    <div className="space-y-2">
                        <Label htmlFor="userEmail">
                            User Email <span className="text-muted-foreground text-xs">(optional)</span>
                        </Label>
                        <Input
                            id="userEmail"
                            type="email"
                            placeholder="bot@your-org.com"
                            value={form.userEmail}
                            onChange={e => setForm(prev => ({ ...prev, userEmail: e.target.value }))}
                        />
                        <p className="text-xs text-muted-foreground">
                            Atlassian account email used for API authentication.
                        </p>
                    </div>

                    {/* API Token */}
                    <div className="space-y-2">
                        <Label htmlFor="apiToken">
                            API Token <span className="text-muted-foreground text-xs">(optional)</span>
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
                                onClick={() => setShowApiToken(v => !v)}
                            >
                                {showApiToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                        <a
                            href="https://id.atlassian.com/manage-profile/security/api-tokens"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline"
                        >
                            Generate an Atlassian API token
                            <ExternalLink className="h-3 w-3" />
                        </a>
                    </div>

                    {/* Enable toggle */}
                    <div className="flex items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                            <Label htmlFor="enabled" className="text-sm font-medium">Enable Jira Integration</Label>
                            <p className="text-xs text-muted-foreground">
                                When disabled, incoming Jira webhook requests will be rejected.
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

            {/* Payload Schema */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Webhook Payload</CardTitle>
                    <CardDescription>
                        JSON body to send from your Jira Automation rule. All fields except{' '}
                        <code className="bg-muted px-1 rounded">taskDescription</code> are optional.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <pre className="bg-muted rounded-md p-4 text-xs overflow-x-auto">
{`{
  "taskDescription": "Check Lambda memory usage in prod",
  "accountId": "123456789012",
  "selectedSkill": "aws-cost-optimization",
  "mode": "fast",
  "issue": {
    "key": "OPS-42",
    "fields": {
      "summary": "High Lambda costs detected",
      "project": { "key": "OPS" },
      "reporter": { "displayName": "Jane Doe" },
      "issuetype": { "name": "Task" }
    }
  }
}`}
                    </pre>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                            copyToClipboard(
                                JSON.stringify(
                                    {
                                        taskDescription: 'Check Lambda memory usage in prod',
                                        accountId: '123456789012',
                                        selectedSkill: 'aws-cost-optimization',
                                        mode: 'fast',
                                        issue: {
                                            key: 'OPS-42',
                                            fields: {
                                                summary: 'High Lambda costs detected',
                                                project: { key: 'OPS' },
                                                reporter: { displayName: 'Jane Doe' },
                                                issuetype: { name: 'Task' },
                                            },
                                        },
                                    },
                                    null,
                                    2
                                ),
                                'payload'
                            )
                        }
                    >
                        {copied === 'payload' ? (
                            <CheckCircle2 className="h-4 w-4 mr-2 text-green-500" />
                        ) : (
                            <Copy className="h-4 w-4 mr-2" />
                        )}
                        Copy example payload
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
                        <li>Generate a random secret and enter it as the <strong className="text-foreground">Webhook Secret</strong> above.</li>
                        <li>
                            In Jira, go to <strong className="text-foreground">Project Settings → Automation</strong> and create a new rule.
                        </li>
                        <li>Add a trigger (e.g. "Issue created" or "Issue transitioned").</li>
                        <li>
                            Add a <strong className="text-foreground">Send web request</strong> action with the webhook URL above,
                            method POST, and the JSON payload.
                        </li>
                        <li>
                            Add a custom header <code className="bg-muted px-1 rounded text-foreground">Authorization</code> with value{' '}
                            <code className="bg-muted px-1 rounded text-foreground">Bearer {'<your-secret>'}</code>.
                        </li>
                        <li>
                            Optionally fill in <strong className="text-foreground">Base URL</strong>, <strong className="text-foreground">User Email</strong>,
                            and <strong className="text-foreground">API Token</strong> above to enable result comments on Jira issues.
                        </li>
                        <li>Save and test the rule — results appear in Agent Ops and as issue comments.</li>
                    </ol>
                </CardContent>
            </Card>
        </div>
    );
}
