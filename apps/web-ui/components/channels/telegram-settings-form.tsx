'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChannelSettings, useSaveChannelSettings, revealChannelSecrets } from '@/lib/queries/channel-settings';
import { ArrowLeft, CheckCircle2, Copy, Eye, EyeOff, Loader2, PlugZap, RefreshCw, Save, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { SetupSteps } from '@/components/channels/setup-steps';
import { ChannelResetCard } from '@/components/channels/channel-reset-card';

interface TelegramSettingsState {
    botToken: string;
    secretToken: string;
    enabled: boolean;
}

interface TelegramSettingsFormProps {
    backHref?: string;
    backLabel?: string;
}

export function TelegramSettingsForm(props: TelegramSettingsFormProps) {
    const { data, isLoading } = useChannelSettings('telegram');
    if (isLoading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }
    return (
        <TelegramSettingsFormInner
            {...props}
            initialConfigured={data?.configured ?? false}
            initialEnabled={data?.enabled ?? true}
        />
    );
}

function TelegramSettingsFormInner({
    backHref = '/agent-ops',
    backLabel = 'Back to Agent Ops',
    initialConfigured,
    initialEnabled,
}: TelegramSettingsFormProps & { initialConfigured: boolean; initialEnabled: boolean }) {
    const router = useRouter();
    const saveMutation = useSaveChannelSettings('telegram');
    const saving = saveMutation.isPending;
    const [configured, setConfigured] = useState(initialConfigured);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [showBotToken, setShowBotToken] = useState(false);
    const [showSecretToken, setShowSecretToken] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const [copied, setCopied] = useState(false);
    const [testing, setTesting] = useState(false);
    const [registering, setRegistering] = useState(false);

    // Lazily pull the stored plaintext secrets into the form the first time the
    // user reveals a field (only when already configured and untouched).
    const revealSecrets = async () => {
        if (revealed || !configured) return;
        setRevealed(true);
        const data = await revealChannelSecrets('telegram');
        setForm(prev => ({
            ...prev,
            botToken: prev.botToken || (data.botToken as string) || '',
            secretToken: prev.secretToken || (data.secretToken as string) || '',
        }));
    };

    const [form, setForm] = useState<TelegramSettingsState>({
        botToken: '',
        secretToken: '',
        enabled: initialEnabled,
    });

    const webhookUrl =
        typeof window !== 'undefined'
            ? `${window.location.origin}/api/v1/gateway/telegram`
            : '/api/v1/gateway/telegram';

    // Telegram secret tokens allow only A-Z a-z 0-9 _ - — hex satisfies that.
    const generateSecret = () => {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        const secret = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        setForm(prev => ({ ...prev, secretToken: secret }));
        setShowSecretToken(true);
        toast.success('Secret token generated — save it here, then it verifies incoming Telegram webhook requests');
    };

    const handleSave = async () => {
        // When already configured, blank fields keep existing stored values.
        if (!configured) {
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
        }
        try {
            setErrorMessage('');
            await saveMutation.mutateAsync({
                botToken: form.botToken,
                secretToken: form.secretToken,
                enabled: form.enabled,
            });
            setConfigured(true);
            setSaveStatus('saved');
            setForm(prev => ({ ...prev, botToken: '', secretToken: '' }));
            setRevealed(false);
            setShowBotToken(false);
            setShowSecretToken(false);
            setTimeout(() => setSaveStatus('idle'), 3000);
        } catch (error: any) {
            setErrorMessage(error.message || 'Failed to save');
            setSaveStatus('error');
        }
    };

    const handleTestConnection = async () => {
        setTesting(true);
        try {
            const res = await fetch('/api/agent-ops/settings/telegram/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ botToken: form.botToken.trim() || undefined }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                toast.success(`Connected as @${data.data.botUsername}`);
                if (!data.data.webhook.isSet) {
                    toast.info('Webhook not registered yet — click "Register Webhook" below.');
                } else if (data.data.webhook.lastErrorMessage) {
                    toast.warning(`Telegram reported a webhook error: ${data.data.webhook.lastErrorMessage}`);
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

    const handleRegisterWebhook = async () => {
        setRegistering(true);
        try {
            const res = await fetch('/api/agent-ops/settings/telegram/webhook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    webhookUrl,
                    botToken: form.botToken.trim() || undefined,
                    secretToken: form.secretToken.trim() || undefined,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                toast.success('Webhook registered with Telegram');
            } else {
                toast.error(data.error || 'Failed to register webhook');
            }
        } catch {
            toast.error('Failed to register webhook — network error');
        } finally {
            setRegistering(false);
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
                    <h1 className="text-2xl font-bold">Telegram Integration</h1>
                    <p className="text-muted-foreground mt-1">
                        Trigger Agent Ops runs by messaging your bot and receive scheduled-task digests and approval
                        requests in Telegram.
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
                <CardContent className="space-y-3">
                    <div className="flex items-center gap-2">
                        <Input readOnly value={webhookUrl} className="font-mono text-sm" />
                        <Button variant="outline" size="icon" onClick={() => copyToClipboard(webhookUrl)}>
                            {copied ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Method: <code className="bg-muted px-1 rounded">POST</code>
                    </p>
                    <div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleRegisterWebhook}
                            disabled={saving || registering || (!configured && !(form.botToken.trim() && form.secretToken.trim()))}
                        >
                            {registering ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                                <Webhook className="h-4 w-4 mr-2" />
                            )}
                            Register Webhook
                        </Button>
                        <p className="text-xs text-muted-foreground mt-2">
                            One-click registration with Telegram. Works only after the Bot Token and Secret Token are
                            saved (or typed above), and the app must be reachable over HTTPS.
                        </p>
                    </div>
                </CardContent>
            </Card>

            {/* Credentials Form */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Credentials</CardTitle>
                    <CardDescription>
                        {configured
                            ? 'Enter new values to update the stored credentials. Leave blank to keep existing values.'
                            : 'Enter your Telegram bot credentials. These are stored securely for your organization.'}
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
                                placeholder={configured ? '••••••••••••' : '123456789:AA...'}
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
                            Get this from <strong>@BotFather</strong> when you create a bot (looks like{' '}
                            <code className="bg-muted px-1 rounded">123456789:AA...</code>).
                        </p>
                    </div>

                    {/* Secret Token */}
                    <div className="space-y-2">
                        <Label htmlFor="secretToken">
                            Secret Token <span className="text-destructive">*</span>
                        </Label>
                        <div className="flex items-center gap-2">
                            <div className="relative flex-1">
                                <Input
                                    id="secretToken"
                                    type={showSecretToken ? 'text' : 'password'}
                                    placeholder={configured ? '••••••••••••' : 'Enter or generate a secret token'}
                                    value={form.secretToken}
                                    onChange={e => setForm(prev => ({ ...prev, secretToken: e.target.value }))}
                                    className="pr-10 font-mono"
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                                    onClick={async () => {
                                        if (!showSecretToken) await revealSecrets();
                                        setShowSecretToken(v => !v);
                                    }}
                                >
                                    {showSecretToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                </Button>
                            </div>
                            <Button type="button" variant="outline" size="sm" onClick={generateSecret}>
                                <RefreshCw className="h-3.5 w-3.5 mr-2" />
                                Generate
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Telegram echoes this back in the{' '}
                            <code className="bg-muted px-1 rounded">X-Telegram-Bot-Api-Secret-Token</code> header on every
                            webhook request, so the platform can verify the request genuinely came from Telegram. Click{' '}
                            <strong>Generate</strong> for a strong value. Allowed characters:{' '}
                            <code className="bg-muted px-1 rounded">A-Z a-z 0-9 _ -</code>.
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
                        Test Connection verifies the Bot Token against Telegram&apos;s{' '}
                        <code className="bg-muted px-1 rounded">getMe</code> API and reports whether the webhook is
                        registered — enter a token above or save one first.
                    </p>
                </CardContent>
            </Card>

            {/* Setup Guide */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Step-by-step Setup Guide</CardTitle>
                    <CardDescription>From zero to a working Telegram integration in a few minutes.</CardDescription>
                </CardHeader>
                <CardContent>
                    <SetupSteps
                        steps={[
                            {
                                title: 'Create the bot',
                                detail: (
                                    <>
                                        Open Telegram and message{' '}
                                        <a
                                            href="https://t.me/BotFather"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-blue-500 hover:underline"
                                        >
                                            @BotFather
                                        </a>
                                        , send <code className="bg-muted px-1 rounded">/newbot</code>, and follow the
                                        prompts to name your bot and pick a username.
                                    </>
                                ),
                            },
                            {
                                title: 'Copy the Bot Token',
                                detail: (
                                    <>
                                        BotFather replies with a token like{' '}
                                        <code className="bg-muted px-1 rounded">123456789:AA...</code> — paste it into the{' '}
                                        <strong className="text-foreground">Bot Token</strong> field above.
                                    </>
                                ),
                            },
                            {
                                title: 'Generate a Secret Token',
                                detail: (
                                    <>
                                        Click <strong className="text-foreground">Generate</strong> next to the Secret
                                        Token field to create a strong value used to verify incoming webhook requests.
                                    </>
                                ),
                            },
                            {
                                title: 'Save Settings',
                                detail: (
                                    <>
                                        Click <strong className="text-foreground">Save Settings</strong> to store the Bot
                                        Token and Secret Token for your organization.
                                    </>
                                ),
                            },
                            {
                                title: 'Register the webhook',
                                detail: (
                                    <>
                                        Click <strong className="text-foreground">Register Webhook</strong> in the Webhook
                                        URL card above to register it with Telegram automatically. If you prefer to do it
                                        manually, open this URL in a browser (replace the placeholders):
                                        <code className="mt-2 block bg-muted px-1 rounded text-xs break-all">
                                            https://api.telegram.org/bot&#123;YOUR_TOKEN&#125;/setWebhook?url=&#123;WEBHOOK_URL&#125;&secret_token=&#123;SECRET_TOKEN&#125;
                                        </code>
                                    </>
                                ),
                            },
                            {
                                title: 'Get your Chat ID',
                                detail: (
                                    <>
                                        Needed when a scheduled task should send its digest to Telegram: message the bot
                                        (or add it to a group), then open{' '}
                                        <code className="bg-muted px-1 rounded text-xs break-all">
                                            https://api.telegram.org/bot&#123;TOKEN&#125;/getUpdates
                                        </code>{' '}
                                        and read <code className="bg-muted px-1 rounded">message.chat.id</code> (group IDs
                                        are negative). Alternatively, message{' '}
                                        <a
                                            href="https://t.me/userinfobot"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-blue-500 hover:underline"
                                        >
                                            @userinfobot
                                        </a>{' '}
                                        for your personal chat ID.
                                    </>
                                ),
                            },
                            {
                                title: 'Test',
                                detail: (
                                    <>
                                        Click <strong className="text-foreground">Test Connection</strong> to verify the
                                        token, then send{' '}
                                        <code className="bg-muted px-1 rounded">/cloudops Check Lambda configs</code> to the
                                        bot.
                                    </>
                                ),
                            },
                        ]}
                    />
                </CardContent>
            </Card>

            <ChannelResetCard
                channel="telegram"
                name="Telegram"
                clears="bot token and secret token"
                configured={configured}
                onReset={() => {
                    setConfigured(false);
                    setRevealed(false);
                    setSaveStatus('idle');
                    setForm({ botToken: '', secretToken: '', enabled: true });
                }}
            />
        </div>
    );
}
