'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Cable, CheckCircle2, Globe, Loader2, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

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
                )}
            </div>
        </div>
    );
}
