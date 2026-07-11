'use client';

import { useState } from 'react';
import { useChannelSettings, useSaveChannelSettings, revealChannelSecrets } from '@/lib/queries/channel-settings';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Copy, Eye, EyeOff, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';

interface DiscordSettingsState {
    applicationId: string;
    publicKey: string;
    botToken: string;
    enabled: boolean;
}

interface DiscordSettingsFormProps {
    backHref?: string;
    backLabel?: string;
}

export function DiscordSettingsForm(props: DiscordSettingsFormProps) {
    const { data, isLoading } = useChannelSettings('discord');
    if (isLoading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }
    return (
        <DiscordSettingsFormInner
            {...props}
            initialConfigured={data?.configured ?? false}
            initialEnabled={data?.enabled ?? true}
        />
    );
}

function DiscordSettingsFormInner({
    backHref = '/channels',
    backLabel = 'Back to Channels',
    initialConfigured,
    initialEnabled,
}: DiscordSettingsFormProps & { initialConfigured: boolean; initialEnabled: boolean }) {
    const router = useRouter();
    const saveMutation = useSaveChannelSettings('discord');
    const saving = saveMutation.isPending;
    const [configured, setConfigured] = useState(initialConfigured);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [showPublicKey, setShowPublicKey] = useState(false);
    const [showBotToken, setShowBotToken] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const [copied, setCopied] = useState(false);

    // Lazily pull the stored plaintext secrets into the form the first time the
    // user reveals a field (only when already configured and untouched).
    const revealSecrets = async () => {
        if (revealed || !configured) return;
        setRevealed(true);
        const data = await revealChannelSecrets('discord');
        setForm(prev => ({
            ...prev,
            applicationId: prev.applicationId || (data.applicationId as string) || '',
            publicKey: prev.publicKey || (data.publicKey as string) || '',
            botToken: prev.botToken || (data.botToken as string) || '',
        }));
    };

    const [form, setForm] = useState<DiscordSettingsState>({
        applicationId: '',
        publicKey: '',
        botToken: '',
        enabled: initialEnabled,
    });

    const interactionsEndpointUrl =
        typeof window !== 'undefined'
            ? `${window.location.origin}/api/v1/gateway/discord`
            : '/api/v1/gateway/discord';

    const handleSave = async () => {
        // When already configured, blank fields keep existing stored values.
        if (!configured) {
            if (!form.applicationId.trim()) {
                setErrorMessage('Application ID is required');
                setSaveStatus('error');
                return;
            }
            if (!form.publicKey.trim()) {
                setErrorMessage('Public Key is required');
                setSaveStatus('error');
                return;
            }
            if (!form.botToken.trim()) {
                setErrorMessage('Bot Token is required');
                setSaveStatus('error');
                return;
            }
        }
        try {
            setErrorMessage('');
            await saveMutation.mutateAsync({
                applicationId: form.applicationId,
                publicKey: form.publicKey,
                botToken: form.botToken,
                enabled: form.enabled,
            });
            setConfigured(true);
            setSaveStatus('saved');
            setForm(prev => ({ ...prev, applicationId: '', publicKey: '', botToken: '' }));
            setRevealed(false);
            setShowPublicKey(false);
            setShowBotToken(false);
            setTimeout(() => setSaveStatus('idle'), 3000);
        } catch (error: any) {
            setErrorMessage(error.message || 'Failed to save');
            setSaveStatus('error');
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
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
                    <h1 className="text-2xl font-bold">Discord Integration</h1>
                    <p className="text-muted-foreground mt-1">
                        Configure your Discord application to trigger Agent Ops runs via slash commands.
                    </p>
                </div>
                {configured && (
                    <Badge variant="secondary" className="gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        Configured
                    </Badge>
                )}
            </div>

            {/* Interactions Endpoint URL */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Interactions Endpoint URL</CardTitle>
                    <CardDescription>
                        Paste this URL into your Discord application under General Information.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center gap-2">
                        <Input readOnly value={interactionsEndpointUrl} className="font-mono text-sm" />
                        <Button variant="outline" size="icon" onClick={() => copyToClipboard(interactionsEndpointUrl)}>
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
                            : 'Enter your Discord application credentials. These are encrypted and stored securely.'}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    {/* Application ID */}
                    <div className="space-y-2">
                        <Label htmlFor="applicationId">
                            Application ID <span className="text-destructive">*</span>
                        </Label>
                        <Input
                            id="applicationId"
                            type="text"
                            placeholder={configured ? '••••••••••••' : 'Enter application ID'}
                            value={form.applicationId}
                            onChange={e => setForm(prev => ({ ...prev, applicationId: e.target.value }))}
                            className="font-mono"
                        />
                        <p className="text-xs text-muted-foreground">
                            Found in your Discord app under <strong>General Information</strong>.
                        </p>
                    </div>

                    {/* Public Key */}
                    <div className="space-y-2">
                        <Label htmlFor="publicKey">
                            Public Key <span className="text-destructive">*</span>
                        </Label>
                        <div className="relative">
                            <Input
                                id="publicKey"
                                type={showPublicKey ? 'text' : 'password'}
                                placeholder={configured ? '••••••••••••' : 'Enter public key'}
                                value={form.publicKey}
                                onChange={e => setForm(prev => ({ ...prev, publicKey: e.target.value }))}
                                className="pr-10 font-mono"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                                onClick={async () => {
                                    if (!showPublicKey) await revealSecrets();
                                    setShowPublicKey(v => !v);
                                }}
                            >
                                {showPublicKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Found in your Discord app under <strong>General Information</strong>.
                        </p>
                    </div>

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
                                onClick={async () => {
                                    if (!showBotToken) await revealSecrets();
                                    setShowBotToken(v => !v);
                                }}
                            >
                                {showBotToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Found in your Discord app under <strong>Bot → Token</strong>.
                        </p>
                    </div>

                    {/* Enable toggle */}
                    <div className="flex items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                            <Label htmlFor="discord-enabled" className="text-sm font-medium">Enable Discord Integration</Label>
                            <p className="text-xs text-muted-foreground">
                                When disabled, incoming Discord interactions will be rejected.
                            </p>
                        </div>
                        <Switch
                            id="discord-enabled"
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
                            Go to <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">discord.com/developers/applications</a> and create a new application.
                        </li>
                        <li>Under <strong className="text-foreground">General Information</strong>, copy the <strong className="text-foreground">Application ID</strong> and <strong className="text-foreground">Public Key</strong>.</li>
                        <li>Under <strong className="text-foreground">Bot</strong>, create a bot and copy the <strong className="text-foreground">Bot Token</strong>.</li>
                        <li>Under <strong className="text-foreground">General Information → Interactions Endpoint URL</strong>, paste the URL shown above.</li>
                        <li>
                            Register a slash command (e.g. <code className="bg-muted px-1 rounded text-foreground">/cloudops</code>) under the application.
                        </li>
                        <li>
                            Generate an OAuth2 URL with <code className="bg-muted px-1 rounded text-foreground">bot</code> and <code className="bg-muted px-1 rounded text-foreground">applications.commands</code> scopes, then invite the bot to your server.
                        </li>
                    </ol>
                </CardContent>
            </Card>
        </div>
    );
}
