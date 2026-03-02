'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
    Plug, Save, RotateCcw, Check, AlertCircle, Loader2, Info, Plus, Copy
} from 'lucide-react';
import Editor, { OnMount } from '@monaco-editor/react';
import { useTheme } from 'next-themes';

// Default config for quick-add templates
const TEMPLATE_SERVERS: Record<string, { command: string; args: string[]; env?: Record<string, string>; description: string }> = {
    'aws-documentation': {
        command: 'uvx',
        args: ['awslabs.aws-documentation-mcp-server@latest'],
        description: 'AWS Documentation & best practices',
    },
    'aws-cdk': {
        command: 'uvx',
        args: ['awslabs.cdk-mcp-server@latest'],
        description: 'AWS CDK guidance & constructs',
    },
    'grafana': {
        command: 'npx',
        args: ['-y', '@leval/mcp-grafana'],
        env: { GRAFANA_URL: 'https://your-grafana-instance.example.com', GRAFANA_TOKEN: 'glsa_xxxxxxxxxxxx' },
        description: 'Grafana dashboards & metrics',
    },
    'kubernetes': {
        command: 'npx',
        args: ['-y', 'mcp-server-kubernetes'],
        description: 'Kubernetes cluster management',
    },
};

// JSON Schema for Monaco auto-validation
const MCP_SCHEMA = {
    uri: 'https://nucleus-platform/mcp-config.schema.json',
    fileMatch: ['*'],
    schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['mcpServers'],
        properties: {
            mcpServers: {
                type: 'object',
                description: 'Map of MCP server configurations keyed by server ID',
                additionalProperties: {
                    type: 'object',
                    required: ['command', 'args'],
                    properties: {
                        command: {
                            type: 'string',
                            description: 'Command to start the MCP server (e.g., "uvx", "npx", "node")',
                        },
                        args: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Arguments to pass to the command',
                        },
                        env: {
                            type: 'object',
                            additionalProperties: { type: 'string' },
                            description: 'Environment variables for the server process',
                        },
                        disabled: {
                            type: 'boolean',
                            description: 'Set to true to disable this server (default: false)',
                        },
                    },
                    additionalProperties: false,
                },
            },
        },
        additionalProperties: false,
    },
};

interface MCPSettingsProps {
    apiPath?: string;
}

export function MCPSettings({ apiPath = '/api/mcp-servers' }: MCPSettingsProps) {
    const { resolvedTheme } = useTheme();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [editorValue, setEditorValue] = useState('');
    const [originalValue, setOriginalValue] = useState('');
    const [isCustom, setIsCustom] = useState(false);
    const [hasChanges, setHasChanges] = useState(false);
    const [isValidJson, setIsValidJson] = useState(true);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [serverSummary, setServerSummary] = useState({ total: 0, enabled: 0 });
    const editorRef = useRef<any>(null);

    // Fetch config on mount
    useEffect(() => {
        fetchConfig();
    }, []);

    const fetchConfig = async () => {
        try {
            setLoading(true);
            const res = await fetch(apiPath);
            if (res.ok) {
                const data = await res.json();
                const json = JSON.stringify(data.config, null, 2);
                setEditorValue(json);
                setOriginalValue(json);
                setIsCustom(data.isCustom);
                updateSummary(data.config);
            }
        } catch (error) {
            console.error('[MCPSettings] Failed to load config:', error);
        } finally {
            setLoading(false);
        }
    };

    const updateSummary = (config: any) => {
        if (!config?.mcpServers) return;
        const entries = Object.entries(config.mcpServers);
        const enabled = entries.filter(([, v]: any) => v.disabled !== true).length;
        setServerSummary({ total: entries.length, enabled });
    };

    const handleEditorChange = useCallback((value: string | undefined) => {
        const val = value || '';
        setEditorValue(val);
        setHasChanges(val !== originalValue);
        setSaveStatus('idle');

        // Validate JSON
        try {
            const parsed = JSON.parse(val);
            setIsValidJson(parsed && typeof parsed.mcpServers === 'object');
            if (parsed?.mcpServers) {
                updateSummary(parsed);
            }
        } catch {
            setIsValidJson(false);
        }
    }, [originalValue]);

    const handleEditorMount: OnMount = (editor, monaco) => {
        editorRef.current = editor;

        // Register JSON schema for validation
        monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
            validate: true,
            schemas: [MCP_SCHEMA],
            allowComments: false,
            trailingCommas: 'error',
        });

        // Auto-format on load
        setTimeout(() => {
            editor.getAction('editor.action.formatDocument')?.run();
        }, 200);
    };

    const handleSave = async () => {
        if (!isValidJson || saving) return;

        try {
            setSaving(true);
            setErrorMessage('');

            const config = JSON.parse(editorValue);
            const res = await fetch(apiPath, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config }),
            });

            if (res.ok) {
                const data = await res.json();
                const json = JSON.stringify(data.config, null, 2);
                setOriginalValue(json);
                setEditorValue(json);
                setHasChanges(false);
                setIsCustom(true);
                setSaveStatus('saved');
                updateSummary(data.config);

                // Clear save status after 3s
                setTimeout(() => setSaveStatus('idle'), 3000);
            } else {
                const err = await res.json();
                setErrorMessage(err.error || 'Failed to save');
                setSaveStatus('error');
            }
        } catch (error: any) {
            setErrorMessage(error.message || 'Failed to save');
            setSaveStatus('error');
        } finally {
            setSaving(false);
        }
    };

    const handleReset = async () => {
        try {
            setSaving(true);
            const res = await fetch(apiPath, { method: 'DELETE' });

            if (res.ok) {
                const data = await res.json();
                const json = JSON.stringify(data.config, null, 2);
                setEditorValue(json);
                setOriginalValue(json);
                setHasChanges(false);
                setIsCustom(false);
                setSaveStatus('saved');
                updateSummary(data.config);
                setTimeout(() => setSaveStatus('idle'), 3000);
            }
        } catch (error) {
            console.error('[MCPSettings] Failed to reset:', error);
            setSaveStatus('error');
        } finally {
            setSaving(false);
        }
    };

    const handleFormat = () => {
        editorRef.current?.getAction('editor.action.formatDocument')?.run();
    };

    const handleCopyConfig = () => {
        navigator.clipboard.writeText(editorValue);
    };

    const handleAddServer = (id: string) => {
        try {
            const config = JSON.parse(editorValue);
            if (config.mcpServers[id]) return; // Already exists

            const template = TEMPLATE_SERVERS[id];
            if (!template) return;

            config.mcpServers[id] = {
                command: template.command,
                args: [...template.args],
                ...(template.env && Object.keys(template.env).length > 0 ? { env: template.env } : {}),
                disabled: false,
            };

            const json = JSON.stringify(config, null, 2);
            setEditorValue(json);
            setHasChanges(json !== originalValue);
            updateSummary(config);

            // Update the editor content
            if (editorRef.current) {
                editorRef.current.setValue(json);
            }
        } catch {
            // Invalid JSON, can't add
        }
    };

    // Determine which templates are available (not already in config)
    const getAvailableTemplates = () => {
        try {
            const config = JSON.parse(editorValue);
            return Object.entries(TEMPLATE_SERVERS).filter(([id]) => !config.mcpServers?.[id]);
        } catch {
            return Object.entries(TEMPLATE_SERVERS);
        }
    };

    return (
        <div className="space-y-4">
            {/* Main Editor Card */}
            <Card>
                <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-green-500/20 to-emerald-500/20 flex items-center justify-center">
                                <Plug className="h-5 w-5 text-green-600 dark:text-green-400" />
                            </div>
                            <div>
                                <CardTitle className="text-lg">MCP Servers Configuration</CardTitle>
                                <CardDescription>
                                    Configure Model Context Protocol servers for the AI agent.
                                    Format follows the VS Code / Cursor MCP convention.
                                </CardDescription>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {isCustom && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium">
                                    CUSTOMIZED
                                </span>
                            )}
                        </div>
                    </div>
                </CardHeader>

                <CardContent className="space-y-3">
                    {/* Toolbar */}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            {/* Save */}
                            <Button
                                size="sm"
                                onClick={handleSave}
                                disabled={!hasChanges || !isValidJson || saving}
                                className={cn(
                                    "h-8 text-xs gap-1.5",
                                    saveStatus === 'saved' && "bg-green-600 hover:bg-green-700"
                                )}
                            >
                                {saving ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : saveStatus === 'saved' ? (
                                    <Check className="h-3.5 w-3.5" />
                                ) : (
                                    <Save className="h-3.5 w-3.5" />
                                )}
                                {saveStatus === 'saved' ? 'Saved' : 'Save'}
                            </Button>

                            {/* Reset */}
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={handleReset}
                                disabled={!isCustom || saving}
                                className="h-8 text-xs gap-1.5"
                                title="Reset to defaults"
                            >
                                <RotateCcw className="h-3.5 w-3.5" />
                                Reset to Defaults
                            </Button>

                            {/* Copy */}
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={handleCopyConfig}
                                className="h-8 text-xs gap-1.5"
                                title="Copy to clipboard"
                            >
                                <Copy className="h-3.5 w-3.5" />
                            </Button>
                        </div>

                        {/* Status */}
                        <div className="flex items-center gap-3">
                            {!isValidJson && (
                                <span className="text-xs text-destructive flex items-center gap-1">
                                    <AlertCircle className="h-3.5 w-3.5" />
                                    Invalid JSON
                                </span>
                            )}
                            {errorMessage && (
                                <span className="text-xs text-destructive max-w-[200px] truncate">{errorMessage}</span>
                            )}
                            <span className="text-xs text-muted-foreground">
                                {serverSummary.total} server{serverSummary.total !== 1 ? 's' : ''} configured,{' '}
                                <span className={cn(serverSummary.enabled > 0 ? "text-green-600 dark:text-green-400 font-medium" : "")}>
                                    {serverSummary.enabled} enabled
                                </span>
                            </span>
                        </div>
                    </div>

                    {/* Monaco Editor */}
                    <div className="border rounded-lg overflow-hidden">
                        {loading ? (
                            <div className="h-[420px] flex items-center justify-center bg-muted/20">
                                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                            </div>
                        ) : (
                            <Editor
                                height="420px"
                                defaultLanguage="json"
                                value={editorValue}
                                onChange={handleEditorChange}
                                onMount={handleEditorMount}
                                theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
                                options={{
                                    minimap: { enabled: false },
                                    fontSize: 13,
                                    lineNumbers: 'on',
                                    folding: true,
                                    bracketPairColorization: { enabled: true },
                                    formatOnPaste: true,
                                    automaticLayout: true,
                                    scrollBeyondLastLine: false,
                                    tabSize: 2,
                                    wordWrap: 'on',
                                    renderLineHighlight: 'line',
                                    padding: { top: 12, bottom: 12 },
                                    scrollbar: {
                                        verticalScrollbarSize: 8,
                                        horizontalScrollbarSize: 8,
                                    },
                                }}
                            />
                        )}
                    </div>

                    {/* Info bar */}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                        <Info className="h-3.5 w-3.5 flex-shrink-0" />
                        <span>
                            Set <code className="px-1 py-0.5 rounded bg-muted text-[11px] font-mono">&quot;disabled&quot;: true</code> to
                            keep a server configured but inactive. Keyboard shortcut: <kbd className="px-1.5 py-0.5 rounded border bg-muted text-[11px]">⌘S</kbd> to save.
                        </span>
                    </div>
                </CardContent>
            </Card>

            {/* Quick Add Card */}
            {getAvailableTemplates().length > 0 && (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium flex items-center gap-2">
                            <Plus className="h-4 w-4" />
                            Add MCP Server
                        </CardTitle>
                        <CardDescription className="text-xs">
                            Quick-add preconfigured server templates to your configuration.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {getAvailableTemplates().map(([id, template]) => (
                                <button
                                    key={id}
                                    onClick={() => handleAddServer(id)}
                                    className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors text-left group"
                                >
                                    <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0 group-hover:bg-primary/20 transition-colors">
                                        <Plug className="h-4 w-4 text-primary" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium truncate">{id}</p>
                                        <p className="text-xs text-muted-foreground truncate">{template.description}</p>
                                    </div>
                                    <Plus className="h-4 w-4 text-muted-foreground ml-auto flex-shrink-0 group-hover:text-primary transition-colors" />
                                </button>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
