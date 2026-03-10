# Channels Module Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a standalone "Channels" sidebar module with a card grid UI that centralises Slack, Jira, and MCP Server configuration — reusing all existing backend and form logic.

**Architecture:** Extract Slack and Jira settings page content into shared components (`web-ui/components/channels/`) with a `backHref` prop; create thin wrapper pages under `web-ui/app/channels/`; add a card-grid landing page that fetches status from existing APIs; add Channels nav item to sidebar. MCP settings already uses the reusable `MCPSettings` component so only needs a thin wrapper.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind CSS, Radix UI, Lucide icons, existing `/api/agent-ops/settings/*` endpoints.

---

## Task 1: Extract SlackSettingsForm shared component

**Files:**
- Create: `web-ui/components/channels/slack-settings-form.tsx`
- Modify: `web-ui/app/agent-ops/slack-settings/page.tsx`

- [ ] **Step 1: Create `web-ui/components/channels/slack-settings-form.tsx`**

Extract all JSX and logic from `app/agent-ops/slack-settings/page.tsx` into a new component. Accept `backHref: string` prop (default `'/agent-ops'`) to control the back button destination. The component is identical to the existing page content except `router.push('/agent-ops')` becomes `router.push(backHref)` and the back button label reads `Back` (generic).

```tsx
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

interface SlackSettingsFormProps {
    backHref?: string;
    backLabel?: string;
}

export function SlackSettingsForm({ backHref = '/agent-ops', backLabel = 'Back to Agent Ops' }: SlackSettingsFormProps) {
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

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Slash Command URL</CardTitle>
                    <CardDescription>Use this URL when creating your Slack app slash command.</CardDescription>
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

                    {saveStatus === 'error' && errorMessage && (
                        <Alert variant="destructive">
                            <AlertDescription>{errorMessage}</AlertDescription>
                        </Alert>
                    )}

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

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Setup Guide</CardTitle>
                </CardHeader>
                <CardContent>
                    <ol className="space-y-3 text-sm text-muted-foreground list-decimal list-inside">
                        <li>Go to <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">api.slack.com/apps</a> and create a new app.</li>
                        <li>Under <strong className="text-foreground">Basic Information</strong>, copy the <strong className="text-foreground">Signing Secret</strong> and paste it above.</li>
                        <li>Under <strong className="text-foreground">Slash Commands</strong>, create a new command (e.g. <code className="bg-muted px-1 rounded text-foreground">/cloud-ops</code>).</li>
                        <li>Set the <strong className="text-foreground">Request URL</strong> to the Slash Command URL shown above.</li>
                        <li>Install the app to your workspace and test the slash command.</li>
                    </ol>
                </CardContent>
            </Card>
        </div>
    );
}
```

- [ ] **Step 2: Replace `app/agent-ops/slack-settings/page.tsx` with thin wrapper**

```tsx
'use client';
import { SlackSettingsForm } from '@/components/channels/slack-settings-form';
export default function SlackSettingsPage() {
    return <SlackSettingsForm backHref="/agent-ops" backLabel="Back to Agent Ops" />;
}
```

---

## Task 2: Extract JiraSettingsForm shared component

**Files:**
- Create: `web-ui/components/channels/jira-settings-form.tsx`
- Modify: `web-ui/app/agent-ops/jira-settings/page.tsx`

- [ ] **Step 1: Create `web-ui/components/channels/jira-settings-form.tsx`**

Same extraction pattern as Slack. Accept `backHref` and `backLabel` props. All content is identical to the existing `app/agent-ops/jira-settings/page.tsx` except the back navigation uses the props.

- [ ] **Step 2: Replace `app/agent-ops/jira-settings/page.tsx` with thin wrapper**

```tsx
'use client';
import { JiraSettingsForm } from '@/components/channels/jira-settings-form';
export default function JiraSettingsPage() {
    return <JiraSettingsForm backHref="/agent-ops" backLabel="Back to Agent Ops" />;
}
```

---

## Task 3: Create Channels card-grid landing page

**Files:**
- Create: `web-ui/app/channels/page.tsx`

The page fetches status from `/api/agent-ops/settings/slack`, `/api/agent-ops/settings/jira`, and `/api/agent-ops/mcp-settings` to show configured/not-configured badges on each card.

Each card has:
- Brand icon (Slack SVG, Jira SVG, Globe lucide icon for MCP)
- Channel name + description
- Status badge
- "Configure" button linking to the sub-page

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Cable, CheckCircle2, Globe, Loader2, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// Inline SVG brand icons
function SlackIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.52 2.528 2.528 0 0 1-2.522-2.52 2.528 2.528 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.528 2.528 0 0 1 2.521-2.52 2.528 2.528 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="currentColor"/>
        </svg>
    );
}

function JiraIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M11.571 11.429 6.286 6.143A1.143 1.143 0 0 0 4.67 7.757l4.474 4.472-4.474 4.472a1.143 1.143 0 1 0 1.616 1.616l5.285-5.286a1.143 1.143 0 0 0 0-1.602z" fill="#2684FF"/>
            <path d="M19.428 11.429 14.143 6.143a1.143 1.143 0 0 0-1.616 1.614l4.474 4.472-4.474 4.472a1.143 1.143 0 1 0 1.616 1.616l5.285-5.286a1.143 1.143 0 0 0 0-1.602z" fill="url(#jira-gradient)"/>
            <defs>
                <linearGradient id="jira-gradient" x1="12.527" y1="11.995" x2="19.428" y2="11.995" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#0052CC"/>
                    <stop offset="1" stopColor="#2684FF"/>
                </linearGradient>
            </defs>
        </svg>
    );
}

interface ChannelStatus {
    slack: { configured: boolean; enabled: boolean } | null;
    jira: { configured: boolean; enabled: boolean } | null;
    mcp: { serverCount: number } | null;
}

export default function ChannelsPage() {
    const [status, setStatus] = useState<ChannelStatus>({ slack: null, jira: null, mcp: null });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        Promise.all([
            fetch('/api/agent-ops/settings/slack').then(r => r.json()).catch(() => null),
            fetch('/api/agent-ops/settings/jira').then(r => r.json()).catch(() => null),
            fetch('/api/agent-ops/mcp-settings').then(r => r.json()).catch(() => null),
        ]).then(([slack, jira, mcp]) => {
            setStatus({
                slack: slack ? { configured: slack.configured ?? false, enabled: slack.enabled ?? false } : null,
                jira: jira ? { configured: jira.configured ?? false, enabled: jira.enabled ?? false } : null,
                mcp: mcp?.servers ? { serverCount: Object.keys(mcp.servers).length } : null,
            });
        }).finally(() => setLoading(false));
    }, []);

    const channels = [
        {
            id: 'slack',
            name: 'Slack',
            description: 'Receive Agent Ops commands via Slack slash commands and get results posted back to your channels.',
            href: '/channels/slack-settings',
            icon: <SlackIcon className="h-8 w-8 text-[#4A154B]" />,
            status: status.slack
                ? status.slack.configured
                    ? { label: 'Configured', variant: 'secondary' as const, icon: true }
                    : { label: 'Not configured', variant: 'outline' as const, icon: false }
                : null,
        },
        {
            id: 'jira',
            name: 'Jira',
            description: 'Trigger agent runs from Jira Automation rules and receive results as issue comments.',
            href: '/channels/jira-settings',
            icon: <JiraIcon className="h-8 w-8" />,
            status: status.jira
                ? status.jira.configured
                    ? { label: 'Configured', variant: 'secondary' as const, icon: true }
                    : { label: 'Not configured', variant: 'outline' as const, icon: false }
                : null,
        },
        {
            id: 'mcp',
            name: 'MCP Servers',
            description: 'Configure external Model Context Protocol servers to extend agent capabilities with custom tools.',
            href: '/channels/mcp-settings',
            icon: <Globe className="h-8 w-8 text-primary" />,
            status: status.mcp
                ? { label: `${status.mcp.serverCount} server${status.mcp.serverCount !== 1 ? 's' : ''}`, variant: 'secondary' as const, icon: true }
                : null,
        },
    ];

    return (
        <div className="flex-1 p-4 md:p-8 pt-6 bg-background">
            <div className="max-w-5xl mx-auto space-y-6">
                {/* Header */}
                <div className="flex items-center gap-3">
                    <Cable className="h-7 w-7 text-primary" />
                    <div>
                        <h1 className="text-2xl font-bold">Channels</h1>
                        <p className="text-muted-foreground mt-0.5 text-sm">
                            Configure integrations and external tool servers used across the platform.
                        </p>
                    </div>
                </div>

                {/* Card grid */}
                {loading ? (
                    <div className="flex items-center justify-center py-16">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {channels.map(channel => (
                            <Card key={channel.id} className="flex flex-col hover:border-primary/50 transition-colors">
                                <CardHeader className="pb-3">
                                    <div className="flex items-start justify-between">
                                        <div className="p-2 rounded-lg bg-muted/50">
                                            {channel.icon}
                                        </div>
                                        {channel.status && (
                                            <Badge variant={channel.status.variant} className="gap-1 text-xs">
                                                {channel.status.icon && (
                                                    <CheckCircle2 className="h-3 w-3 text-green-500" />
                                                )}
                                                {channel.status.label}
                                            </Badge>
                                        )}
                                    </div>
                                    <CardTitle className="text-base mt-3">{channel.name}</CardTitle>
                                    <CardDescription className="text-sm leading-relaxed">
                                        {channel.description}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="mt-auto pt-0">
                                    <Link href={channel.href}>
                                        <Button variant="outline" size="sm" className="w-full gap-2">
                                            <Settings2 className="h-3.5 w-3.5" />
                                            Configure
                                        </Button>
                                    </Link>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
```

---

## Task 4: Create Channels sub-pages (thin wrappers)

**Files:**
- Create: `web-ui/app/channels/slack-settings/page.tsx`
- Create: `web-ui/app/channels/jira-settings/page.tsx`
- Create: `web-ui/app/channels/mcp-settings/page.tsx`

- [ ] **Step 1: `web-ui/app/channels/slack-settings/page.tsx`**

```tsx
'use client';
import { SlackSettingsForm } from '@/components/channels/slack-settings-form';
export default function ChannelsSlackSettingsPage() {
    return <SlackSettingsForm backHref="/channels" backLabel="Back to Channels" />;
}
```

- [ ] **Step 2: `web-ui/app/channels/jira-settings/page.tsx`**

```tsx
'use client';
import { JiraSettingsForm } from '@/components/channels/jira-settings-form';
export default function ChannelsJiraSettingsPage() {
    return <JiraSettingsForm backHref="/channels" backLabel="Back to Channels" />;
}
```

- [ ] **Step 3: `web-ui/app/channels/mcp-settings/page.tsx`**

```tsx
'use client';
import { MCPSettings } from '@/components/settings/mcp-settings';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';

export default function ChannelsMCPSettingsPage() {
    const router = useRouter();
    return (
        <div className="flex-1 p-4 md:p-8 pt-6 bg-background max-w-4xl mx-auto">
            <div className="mb-6">
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2 text-muted-foreground hover:text-foreground -ml-2"
                    onClick={() => router.push('/channels')}
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back to Channels
                </Button>
            </div>
            <MCPSettings apiPath="/api/agent-ops/mcp-settings" />
        </div>
    );
}
```

---

## Task 5: Add Channels to sidebar

**Files:**
- Modify: `web-ui/components/sidebar.tsx`

- [ ] **Step 1: Add `Cable` to lucide-react import and add nav item**

In `web-ui/components/sidebar.tsx`:

1. Add `Cable` to the lucide-react import
2. Add the Channels nav item after Agent Ops:

```tsx
{ name: "Channels", href: "/channels", icon: Cable },
```

---

## Task 6: Commit

- [ ] **Step 1: Commit all changes**

```bash
git add web-ui/components/channels/ \
        web-ui/app/channels/ \
        web-ui/app/agent-ops/slack-settings/page.tsx \
        web-ui/app/agent-ops/jira-settings/page.tsx \
        web-ui/components/sidebar.tsx
git commit -m "feat: add Channels module with Slack, Jira, and MCP card grid"
```
