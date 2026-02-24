'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Copy, ExternalLink, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function JiraSettingsPage() {
    const router = useRouter();
    const [copied, setCopied] = useState<string | null>(null);

    const webhookUrl =
        typeof window !== 'undefined'
            ? `${window.location.origin}/api/v1/trigger/jira`
            : '/api/v1/trigger/jira';

    const copyToClipboard = (text: string, key: string) => {
        navigator.clipboard.writeText(text);
        setCopied(key);
        setTimeout(() => setCopied(null), 2000);
    };

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

            <div>
                <h1 className="text-2xl font-bold">Jira Integration</h1>
                <p className="text-muted-foreground mt-1">
                    Trigger Agent Ops runs from Jira Automation rules and receive results as issue comments.
                </p>
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

            {/* Authentication */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Authentication</CardTitle>
                    <CardDescription>
                        Set a shared secret to secure the webhook. Add it as a custom header in your Jira Automation rule.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <Alert>
                        <Info className="h-4 w-4" />
                        <AlertDescription className="text-sm">
                            Set <code className="bg-muted px-1 rounded">JIRA_WEBHOOK_SECRET</code> in your environment variables,
                            then configure the same value as a custom header in Jira Automation.
                        </AlertDescription>
                    </Alert>

                    <div className="space-y-2">
                        <Label className="text-sm">Custom Header Name</Label>
                        <div className="flex items-center gap-2">
                            <Input readOnly value="Authorization" className="font-mono text-sm" />
                            <Button
                                variant="outline"
                                size="icon"
                                onClick={() => copyToClipboard('Authorization', 'header')}
                            >
                                {copied === 'header' ? (
                                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                                ) : (
                                    <Copy className="h-4 w-4" />
                                )}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Header value format: <code className="bg-muted px-1 rounded">Bearer {'<your-secret>'}</code>
                        </p>
                    </div>
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
                    <div className="flex items-center gap-2">
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
                    </div>
                </CardContent>
            </Card>

            {/* Result Notifications */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Result Notifications</CardTitle>
                    <CardDescription>
                        Agent Ops can post run results back to the Jira issue as a comment.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 text-sm">
                        {[
                            { key: 'JIRA_BASE_URL', example: 'https://your-org.atlassian.net', desc: 'Your Atlassian instance URL' },
                            { key: 'JIRA_USER_EMAIL', example: 'bot@your-org.com', desc: 'Atlassian account email for API auth' },
                            { key: 'JIRA_API_TOKEN', example: 'ATATT3x...', desc: 'Atlassian API token' },
                        ].map(({ key, example, desc }) => (
                            <div key={key} className="rounded-md border p-3 space-y-1">
                                <div className="flex items-center justify-between">
                                    <code className="text-xs font-semibold">{key}</code>
                                    <Badge variant="outline" className="text-xs">env var</Badge>
                                </div>
                                <p className="text-xs text-muted-foreground">{desc}</p>
                                <p className="text-xs text-muted-foreground font-mono">e.g. {example}</p>
                            </div>
                        ))}
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
                </CardContent>
            </Card>

            {/* Setup Steps */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Setup Guide</CardTitle>
                </CardHeader>
                <CardContent>
                    <ol className="space-y-3 text-sm text-muted-foreground list-decimal list-inside">
                        <li>Set <code className="bg-muted px-1 rounded text-foreground">JIRA_WEBHOOK_SECRET</code> in your environment.</li>
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
                            Optionally set <code className="bg-muted px-1 rounded text-foreground">JIRA_BASE_URL</code>,{' '}
                            <code className="bg-muted px-1 rounded text-foreground">JIRA_USER_EMAIL</code>, and{' '}
                            <code className="bg-muted px-1 rounded text-foreground">JIRA_API_TOKEN</code> to enable result comments.
                        </li>
                        <li>Save and test the rule — results appear in Agent Ops and as issue comments.</li>
                    </ol>
                </CardContent>
            </Card>
        </div>
    );
}
