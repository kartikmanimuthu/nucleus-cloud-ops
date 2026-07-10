'use client';

import { useChannelStatus } from '@/lib/queries/channels';
import Link from 'next/link';
import { Cable, CheckCircle2, Globe, Loader2, Settings2, Server, Send, Webhook } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/shared/page-header';

function SlackIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.52 2.528 2.528 0 0 1-2.522-2.52 2.528 2.528 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.528 2.528 0 0 1 2.521-2.52 2.528 2.528 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="currentColor"/>
        </svg>
    );
}

function JiraIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M11.571 11.429 6.286 6.143A1.143 1.143 0 0 0 4.67 7.757l4.474 4.472-4.474 4.472a1.143 1.143 0 1 0 1.616 1.616l5.285-5.286a1.143 1.143 0 0 0 0-1.602z" fill="#2684FF"/>
            <path d="M19.428 11.429 14.143 6.143a1.143 1.143 0 0 0-1.616 1.614l4.474 4.472-4.474 4.472a1.143 1.143 0 1 0 1.616 1.616l5.285-5.286a1.143 1.143 0 0 0 0-1.602z" fill="url(#jira-gradient-channels)"/>
            <defs>
                <linearGradient id="jira-gradient-channels" x1="12.527" y1="11.995" x2="19.428" y2="11.995" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#0052CC"/>
                    <stop offset="1" stopColor="#2684FF"/>
                </linearGradient>
            </defs>
        </svg>
    );
}

function GoogleIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" fill="#34A853"/>
            <path d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" fill="#EA4335"/>
        </svg>
    );
}

function DiscordIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z" fill="currentColor"/>
        </svg>
    );
}

function TelegramIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" fill="currentColor"/>
        </svg>
    );
}


export default function ChannelsPage() {
    const channelQuery = useChannelStatus();
    const status = channelQuery.data ?? {
        slack: null, jira: null, google: null, discord: null, telegram: null, webhook: null, mcp: null, providers: null,
    };
    const loading = channelQuery.isLoading;

    const channels = [
        {
            id: 'slack',
            name: 'Slack',
            description: 'Receive Agent Ops commands via Slack slash commands and get results posted back to your channels.',
            href: '/app/channels/slack-settings',
            icon: <SlackIcon className="h-8 w-8 text-[#4A154B] dark:text-[#E8B4E8]" />,
            statusBadge: status.slack
                ? status.slack.configured
                    ? <Badge variant="secondary" className="gap-1 text-xs"><CheckCircle2 className="h-3 w-3 text-green-500" />Configured</Badge>
                    : <Badge variant="outline" className="text-xs text-muted-foreground">Not configured</Badge>
                : null,
        },
        {
            id: 'jira',
            name: 'Jira',
            description: 'Trigger agent runs from Jira Automation rules and receive results as issue comments.',
            href: '/app/channels/jira-settings',
            icon: <JiraIcon className="h-8 w-8" />,
            statusBadge: status.jira
                ? status.jira.configured
                    ? <Badge variant="secondary" className="gap-1 text-xs"><CheckCircle2 className="h-3 w-3 text-green-500" />Configured</Badge>
                    : <Badge variant="outline" className="text-xs text-muted-foreground">Not configured</Badge>
                : null,
        },
        {
            id: 'google',
            name: 'Google',
            description: 'Connect a Google account (OAuth) for Gmail and Calendar access the agent can act on.',
            href: '/app/channels/google-settings',
            icon: <GoogleIcon className="h-8 w-8" />,
            statusBadge: status.google
                ? status.google.configured
                    ? <Badge variant="secondary" className="gap-1 text-xs"><CheckCircle2 className="h-3 w-3 text-green-500" />Configured</Badge>
                    : <Badge variant="outline" className="text-xs text-muted-foreground">Not configured</Badge>
                : null,
        },
        {
            id: 'discord',
            name: 'Discord',
            description: 'Run agent commands via Discord slash commands with rich embeds and real-time streaming updates.',
            href: '/app/channels/discord-settings',
            icon: <DiscordIcon className="h-8 w-8 text-[#5865F2]" />,
            statusBadge: status.discord
                ? status.discord.configured
                    ? <Badge variant="secondary" className="gap-1 text-xs"><CheckCircle2 className="h-3 w-3 text-green-500" />Configured</Badge>
                    : <Badge variant="outline" className="text-xs text-muted-foreground">Not configured</Badge>
                : null,
        },
        {
            id: 'telegram',
            name: 'Telegram',
            description: 'Trigger agent runs from Telegram bot commands with inline keyboard approvals and streaming.',
            href: '/app/channels/telegram-settings',
            icon: <TelegramIcon className="h-8 w-8 text-[#26A5E4]" />,
            statusBadge: status.telegram
                ? status.telegram.configured
                    ? <Badge variant="secondary" className="gap-1 text-xs"><CheckCircle2 className="h-3 w-3 text-green-500" />Configured</Badge>
                    : <Badge variant="outline" className="text-xs text-muted-foreground">Not configured</Badge>
                : null,
        },
        {
            id: 'webhook',
            name: 'Webhook',
            description: 'Generic HTTP webhook for any external system. Send tasks via POST and receive results at your callback URL.',
            href: '/app/channels/webhook-settings',
            icon: <Webhook className="h-8 w-8 text-orange-500" />,
            statusBadge: status.webhook
                ? status.webhook.configured
                    ? <Badge variant="secondary" className="gap-1 text-xs"><CheckCircle2 className="h-3 w-3 text-green-500" />Configured</Badge>
                    : <Badge variant="outline" className="text-xs text-muted-foreground">Not configured</Badge>
                : null,
        },
        {
            id: 'mcp',
            name: 'MCP Servers',
            description: 'Configure external Model Context Protocol servers to extend agent capabilities with custom tools.',
            href: '/app/channels/mcp-settings',
            icon: <Globe className="h-8 w-8 text-primary" />,
            statusBadge: status.mcp
                ? <Badge variant="secondary" className="gap-1 text-xs">
                    <CheckCircle2 className="h-3 w-3 text-green-500" />
                    {status.mcp.serverCount} server{status.mcp.serverCount !== 1 ? 's' : ''}
                  </Badge>
                : null,
        },
    ];

    return (
        <div className="flex-1 bg-background">
            <div className="max-w-5xl mx-auto space-y-6">
                {/* Header */}
                <PageHeader
                    icon={Cable}
                    title="Channels"
                    description="Configure integrations and external tool servers used across the platform."
                />

                {/* Card grid */}
                {loading ? (
                    <div className="flex items-center justify-center py-16">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {channels.map(channel => (
                            <Card key={channel.id} className="flex flex-col hover:border-primary/50 transition-colors">
                                <CardHeader className="pb-3">
                                    <div className="flex items-start justify-between">
                                        <div className="p-2 rounded-lg bg-muted/50">
                                            {channel.icon}
                                        </div>
                                        {channel.statusBadge}
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

                    {/* Separator */}
                    <div className="border-t pt-6">
                        <div className="flex items-center gap-3 mb-4">
                            <Server className="h-5 w-5 text-primary" />
                            <div>
                                <h2 className="text-lg font-semibold">Model Providers</h2>
                                <p className="text-muted-foreground text-sm">
                                    Connect Ollama, LM Studio, LiteLLM, Anthropic, or other LLM endpoints to use alongside AWS Bedrock.
                                </p>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            <Link href="/app/settings/providers">
                                <Card className="flex flex-col hover:border-primary/50 transition-colors cursor-pointer h-full">
                                    <CardHeader className="pb-3">
                                        <div className="flex items-start justify-between">
                                            <div className="p-2 rounded-lg bg-muted/50">
                                                <Server className="h-8 w-8 text-primary" />
                                            </div>
                                            {status.providers && status.providers.count > 0
                                                ? <Badge variant="secondary" className="gap-1 text-xs">
                                                    <CheckCircle2 className="h-3 w-3 text-green-500" />
                                                    {status.providers.count} provider{status.providers.count !== 1 ? 's' : ''}
                                                  </Badge>
                                                : <Badge variant="outline" className="text-xs text-muted-foreground">Not configured</Badge>
                                            }
                                        </div>
                                        <CardTitle className="text-base mt-3">LLM Providers</CardTitle>
                                        <CardDescription className="text-sm leading-relaxed">
                                            Configure LLM endpoints (Ollama, LM Studio, LiteLLM, Anthropic, vLLM) to use in AI Ops.
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent className="mt-auto pt-0">
                                        <Button variant="outline" size="sm" className="w-full gap-2">
                                            <Settings2 className="h-3.5 w-3.5" />
                                            Configure
                                        </Button>
                                    </CardContent>
                                </Card>
                            </Link>
                        </div>
                    </div>
                    </>
                )}
            </div>
        </div>
    );
}
