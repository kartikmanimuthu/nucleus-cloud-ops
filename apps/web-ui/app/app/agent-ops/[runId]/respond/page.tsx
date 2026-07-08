// web-ui/app/app/agent-ops/[runId]/respond/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface RunData {
    runId: string;
    status: string;
    taskDescription: string;
    source: string;
    clarification?: { question: string; missingInfo: string };
    approvalRequest?: { planSteps: string[]; pendingTools?: string[]; approvalType: string };
}

export default function RespondPage() {
    const params = useParams();
    const router = useRouter();
    const runId = params.runId as string;
    const [run, setRun] = useState<RunData | null>(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [clarificationText, setClarificationText] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch(`/api/agent-ops/${runId}`)
            .then(res => res.json())
            .then(data => {
                if (data.run) setRun(data.run);
                else setError('Run not found');
            })
            .catch(() => setError('Failed to load run'))
            .finally(() => setLoading(false));
    }, [runId]);

    const handleApprove = async () => {
        setSubmitting(true);
        try {
            await fetch(`/api/agent-ops/${runId}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'approve' }),
            });
            router.push('/app/agent-ops');
        } catch {
            setError('Failed to approve');
        } finally {
            setSubmitting(false);
        }
    };

    const handleReject = async () => {
        setSubmitting(true);
        try {
            await fetch(`/api/agent-ops/${runId}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'reject' }),
            });
            router.push('/app/agent-ops');
        } catch {
            setError('Failed to reject');
        } finally {
            setSubmitting(false);
        }
    };

    const handleClarification = async () => {
        if (!clarificationText.trim()) return;
        setSubmitting(true);
        try {
            await fetch(`/api/agent-ops/${runId}/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userInput: clarificationText }),
            });
            router.push('/app/agent-ops');
        } catch {
            setError('Failed to submit');
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) return <div className="flex items-center justify-center min-h-[400px]">Loading...</div>;
    if (error) return <div className="flex items-center justify-center min-h-[400px] text-destructive">{error}</div>;
    if (!run) return null;

    const isAwaitingInput = run.status === 'awaiting_input';
    const isAwaitingApproval = run.status === 'awaiting_approval';

    if (!isAwaitingInput && !isAwaitingApproval) {
        return (
            <div className="max-w-2xl mx-auto p-6">
                <Card>
                    <CardHeader>
                        <CardTitle>Run {runId.slice(0, 8)}...</CardTitle>
                        <CardDescription>This run is no longer awaiting input.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Badge>{run.status}</Badge>
                        <p className="mt-4 text-sm text-muted-foreground">{run.taskDescription}</p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="max-w-2xl mx-auto p-6 space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle>Agent Ops — Response Required</CardTitle>
                    <CardDescription>
                        Run <code className="text-xs">{runId.slice(0, 8)}...</code> from <Badge variant="outline">{run.source}</Badge>
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm">{run.taskDescription}</p>

                    {isAwaitingInput && run.clarification && (
                        <div className="space-y-3">
                            <div className="rounded-md bg-muted p-3">
                                <p className="text-sm font-medium">Clarification needed:</p>
                                <p className="text-sm mt-1">{run.clarification.question}</p>
                            </div>
                            <Textarea
                                placeholder="Type your response..."
                                value={clarificationText}
                                onChange={e => setClarificationText(e.target.value)}
                                rows={4}
                            />
                            <Button onClick={handleClarification} disabled={submitting || !clarificationText.trim()}>
                                {submitting ? 'Submitting...' : 'Submit Response'}
                            </Button>
                        </div>
                    )}

                    {isAwaitingApproval && run.approvalRequest && (
                        <div className="space-y-3">
                            <div className="rounded-md bg-muted p-3">
                                <p className="text-sm font-medium">Execution Plan:</p>
                                <ol className="list-decimal list-inside text-sm mt-1 space-y-1">
                                    {run.approvalRequest.planSteps.map((step, i) => (
                                        <li key={i}>{step}</li>
                                    ))}
                                </ol>
                                {run.approvalRequest.pendingTools && run.approvalRequest.pendingTools.length > 0 && (
                                    <p className="text-sm mt-2">
                                        Tools: {run.approvalRequest.pendingTools.map(t => <code key={t} className="mx-1 text-xs">{t}</code>)}
                                    </p>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <Button onClick={handleApprove} disabled={submitting}>
                                    {submitting ? 'Processing...' : 'Approve'}
                                </Button>
                                <Button variant="destructive" onClick={handleReject} disabled={submitting}>
                                    {submitting ? 'Processing...' : 'Reject'}
                                </Button>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
