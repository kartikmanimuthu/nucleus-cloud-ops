"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Trash2, Plus, TestTube, Loader2, Server } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

interface ProviderModel {
    id: string;
    label: string;
    maxTokens?: number;
}

interface Provider {
    id: string;
    name: string;
    provider: string;
    baseUrl: string;
    apiKey: string | null;
    models: ProviderModel[];
    isEnabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export function ProviderSettings() {
    const [providers, setProviders] = useState<Provider[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [testing, setTesting] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);

    const [formName, setFormName] = useState("");
    const [formBaseUrl, setFormBaseUrl] = useState("");
    const [formApiKey, setFormApiKey] = useState("");
    const [formModels, setFormModels] = useState<ProviderModel[]>([{ id: "", label: "", maxTokens: 8000 }]);
    const [saving, setSaving] = useState(false);

    const fetchProviders = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/settings/providers");
            const json = await res.json();
            if (!res.ok || !json.success) {
                setError(json.error ?? "Failed to load providers.");
                return;
            }
            setProviders(json.data.providers ?? []);
        } catch {
            setError("Failed to load providers.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchProviders(); }, [fetchProviders]);

    const handleCreate = async () => {
        setSaving(true);
        try {
            const validModels = formModels.filter(m => m.id.trim() && m.label.trim());
            if (validModels.length === 0) {
                setError("At least one model with ID and label is required.");
                setSaving(false);
                return;
            }
            const res = await fetch("/api/settings/providers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: formName,
                    baseUrl: formBaseUrl,
                    apiKey: formApiKey || undefined,
                    models: validModels,
                }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to create provider");
            setDialogOpen(false);
            resetForm();
            await fetchProviders();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create provider");
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        try {
            const res = await fetch(`/api/settings/providers/${id}`, { method: "DELETE" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error);
            await fetchProviders();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to delete provider");
        }
    };

    const handleToggle = async (id: string, isEnabled: boolean) => {
        try {
            const res = await fetch(`/api/settings/providers/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ isEnabled }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error);
            await fetchProviders();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update provider");
        }
    };

    const handleTest = async (id: string) => {
        setTesting(id);
        setTestResult(null);
        try {
            const res = await fetch(`/api/settings/providers/${id}/test`, { method: "POST" });
            const json = await res.json();
            setTestResult({
                id,
                success: json.success,
                message: json.success
                    ? `Connected. ${json.data?.availableModels?.length ?? 0} models available.`
                    : json.error ?? "Connection failed",
            });
        } catch {
            setTestResult({ id, success: false, message: "Connection failed" });
        } finally {
            setTesting(null);
        }
    };

    const resetForm = () => {
        setFormName("");
        setFormBaseUrl("");
        setFormApiKey("");
        setFormModels([{ id: "", label: "", maxTokens: 8000 }]);
    };

    const addModelField = () => setFormModels([...formModels, { id: "", label: "", maxTokens: 8000 }]);

    const updateModelField = (index: number, field: "id" | "label" | "maxTokens", value: string) => {
        const updated = [...formModels];
        if (field === "maxTokens") {
            const parsed = parseInt(value, 10);
            updated[index] = { ...updated[index], maxTokens: isNaN(parsed) ? 8000 : Math.min(200000, Math.max(1, parsed)) };
        } else {
            updated[index] = { ...updated[index], [field]: value };
        }
        setFormModels(updated);
    };

    const removeModelField = (index: number) => {
        if (formModels.length <= 1) return;
        setFormModels(formModels.filter((_, i) => i !== index));
    };

    return (
        <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 bg-background">
            <div className="flex items-center justify-between">
                <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                        <Server className="h-6 w-6" />
                        <h2 className="text-3xl font-bold tracking-tight text-foreground">LLM Providers</h2>
                    </div>
                    <p className="text-muted-foreground">
                        Configure self-hosted LLM endpoints (Ollama, vLLM, LiteLLM) for your organization.
                    </p>
                </div>
                <Button onClick={() => { resetForm(); setDialogOpen(true); }}>
                    <Plus className="mr-2 h-4 w-4" /> Add Provider
                </Button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {loading ? (
                <p className="text-muted-foreground text-sm">Loading providers...</p>
            ) : providers.length === 0 ? (
                <Card>
                    <CardHeader>
                        <CardTitle>No providers configured</CardTitle>
                        <CardDescription>
                            Add a self-hosted LLM provider to use open-source models alongside AWS Bedrock.
                        </CardDescription>
                    </CardHeader>
                </Card>
            ) : (
                <div className="grid gap-4">
                    {providers.map((p) => (
                        <Card key={p.id}>
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <div>
                                    <CardTitle className="text-lg">{p.name}</CardTitle>
                                    <CardDescription className="font-mono text-xs">{p.baseUrl}</CardDescription>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Button variant="outline" size="sm" onClick={() => handleTest(p.id)} disabled={testing === p.id}>
                                        {testing === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <TestTube className="h-4 w-4" />}
                                        <span className="ml-1">Test</span>
                                    </Button>
                                    <Switch checked={p.isEnabled} onCheckedChange={(v) => handleToggle(p.id, v)} />
                                    <Button variant="ghost" size="sm" onClick={() => handleDelete(p.id)}>
                                        <Trash2 className="h-4 w-4 text-destructive" />
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="flex flex-wrap gap-2">
                                    {(p.models as ProviderModel[]).map((m) => (
                                        <Badge key={m.id} variant="secondary">
                                            {m.label || m.id}
                                            {m.maxTokens && <span className="ml-1 text-xs opacity-60">{(m.maxTokens / 1000).toFixed(0)}k</span>}
                                        </Badge>
                                    ))}
                                </div>
                                {testResult?.id === p.id && (
                                    <p className={`mt-2 text-sm ${testResult.success ? 'text-green-600' : 'text-destructive'}`}>
                                        {testResult.message}
                                    </p>
                                )}
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Add LLM Provider</DialogTitle>
                        <DialogDescription>
                            Configure an OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM, LocalAI).
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div>
                            <Label htmlFor="provider-name">Name</Label>
                            <Input id="provider-name" placeholder="Internal vLLM Cluster" value={formName} onChange={(e) => setFormName(e.target.value)} />
                        </div>
                        <div>
                            <Label htmlFor="provider-url">Base URL</Label>
                            <Input id="provider-url" placeholder="http://vllm.internal:8000/v1" value={formBaseUrl} onChange={(e) => setFormBaseUrl(e.target.value)} />
                        </div>
                        <div>
                            <Label htmlFor="provider-key">API Key (optional)</Label>
                            <Input id="provider-key" type="password" placeholder="sk-..." value={formApiKey} onChange={(e) => setFormApiKey(e.target.value)} />
                        </div>
                        <div>
                            <Label>Models</Label>
                            <div className="space-y-2 mt-1">
                                <div className="flex gap-2 text-xs text-muted-foreground px-1">
                                    <span className="flex-1">Model ID</span>
                                    <span className="w-40">Display label</span>
                                    <span className="w-32">Max tokens</span>
                                    {formModels.length > 1 && <span className="w-8" />}
                                </div>
                                {formModels.map((m, i) => (
                                    <div key={i} className="flex gap-2 items-center">
                                        <Input placeholder="Model ID (e.g. meta-llama/Llama-3.3-70B)" value={m.id} onChange={(e) => updateModelField(i, "id", e.target.value)} />
                                        <Input placeholder="Display label" value={m.label} onChange={(e) => updateModelField(i, "label", e.target.value)} className="w-40" />
                                        <Input
                                            placeholder="Max tokens"
                                            type="number"
                                            min={1}
                                            max={200000}
                                            value={m.maxTokens ?? 8000}
                                            onChange={(e) => updateModelField(i, "maxTokens", e.target.value)}
                                            className="w-32"
                                        />
                                        {formModels.length > 1 && (
                                            <Button variant="ghost" size="sm" onClick={() => removeModelField(i)}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </div>
                                ))}
                                <Button variant="outline" size="sm" onClick={addModelField}>
                                    <Plus className="h-3 w-3 mr-1" /> Add Model
                                </Button>
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleCreate} disabled={saving || !formName.trim() || !formBaseUrl.trim()}>
                            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            Add Provider
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
