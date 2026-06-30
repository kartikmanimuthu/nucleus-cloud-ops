"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    useCreateProvider,
    useUpdateProvider,
    useDiscoverModels,
    useProbeEmbedding,
    type Provider,
    type ProviderType,
    type DiscoveredModel,
    type ProviderCredentialsInput,
    type CreateProviderInput,
    type ProviderModelEntry,
    type EmbeddingProbeResult,
} from "@/lib/queries/providers";

/** Which credential fields a provider type exposes in the wizard. */
type CredentialField = "region" | "accessKeyId" | "secretAccessKey" | "apiKey" | "baseUrl";

interface ProviderTypeMeta {
    label: string;
    /** Fields rendered in step 2, in display order. */
    fields: CredentialField[];
    /** Subset of `fields` that the user must fill before discovery. */
    required: CredentialField[];
    /** Prefill value for the base URL field (empty = no default). */
    defaultBaseUrl: string;
    /** Whether this type uses a region (and thus an AWS-style credential set). */
    hasRegion: boolean;
}

/**
 * Provider-type matrix — single source of truth for the type Select options,
 * dynamic credential fields, default base URL prefill, and client validation.
 */
export const PROVIDER_TYPE_META: Record<ProviderType, ProviderTypeMeta> = {
    bedrock: {
        label: "Amazon Bedrock",
        fields: ["region", "accessKeyId", "secretAccessKey"],
        required: ["region", "accessKeyId", "secretAccessKey"],
        defaultBaseUrl: "",
        hasRegion: true,
    },
    openai: {
        label: "OpenAI",
        fields: ["apiKey", "baseUrl"],
        required: ["apiKey"],
        defaultBaseUrl: "https://api.openai.com/v1",
        hasRegion: false,
    },
    anthropic: {
        label: "Anthropic",
        fields: ["apiKey", "baseUrl"],
        required: ["apiKey"],
        defaultBaseUrl: "https://api.anthropic.com",
        hasRegion: false,
    },
    ollama: {
        label: "Ollama",
        fields: ["baseUrl", "apiKey"],
        required: ["baseUrl"],
        defaultBaseUrl: "http://localhost:11434",
        hasRegion: false,
    },
    vllm: {
        label: "vLLM",
        fields: ["baseUrl", "apiKey"],
        required: ["baseUrl"],
        defaultBaseUrl: "",
        hasRegion: false,
    },
    lmstudio: {
        label: "LM Studio",
        fields: ["baseUrl", "apiKey"],
        required: ["baseUrl"],
        defaultBaseUrl: "http://localhost:1234/v1",
        hasRegion: false,
    },
    litellm: {
        label: "LiteLLM Gateway",
        fields: ["baseUrl", "apiKey"],
        required: ["baseUrl"],
        defaultBaseUrl: "http://localhost:4000/v1",
        hasRegion: false,
    },
    "openai-compatible": {
        label: "OpenAI Compatible",
        fields: ["baseUrl", "apiKey"],
        required: ["baseUrl"],
        defaultBaseUrl: "",
        hasRegion: false,
    },
};

const PROVIDER_TYPE_ORDER: ProviderType[] = [
    "bedrock",
    "openai",
    "anthropic",
    "ollama",
    "vllm",
    "lmstudio",
    "litellm",
    "openai-compatible",
];

const FIELD_META: Record<CredentialField, { label: string; placeholder: string; type: string }> = {
    region: { label: "Region", placeholder: "us-east-1", type: "text" },
    accessKeyId: { label: "Access Key ID", placeholder: "AKIA...", type: "text" },
    secretAccessKey: { label: "Secret Access Key", placeholder: "••••••••", type: "password" },
    apiKey: { label: "API Key", placeholder: "sk-...", type: "password" },
    baseUrl: { label: "Base URL", placeholder: "https://...", type: "text" },
};

const NONE_VALUE = "__none__";

/** Platform-wide embedding dimension (pgvector columns are fixed vector(1024)). */
const PLATFORM_EMBEDDING_DIMS = 1024;

/** A discovered model is chat-capable if it lists 'chat' or lists no capabilities at all. */
function isChatModel(m: DiscoveredModel): boolean {
    return !m.capabilities || m.capabilities.length === 0 || m.capabilities.includes("chat");
}

function isEmbeddingModel(m: DiscoveredModel): boolean {
    return Boolean(m.capabilities?.includes("embedding"));
}

export function ProviderWizard({
    mode,
    provider,
}: {
    mode: "create" | "edit";
    provider?: Provider;
}) {
    const router = useRouter();
    const createProvider = useCreateProvider();
    const updateProvider = useUpdateProvider();
    const discoverModels = useDiscoverModels();
    const probeEmbedding = useProbeEmbedding();

    const [step, setStep] = useState(0);

    // Step 1
    const [name, setName] = useState(provider?.name ?? "");
    const [providerType, setProviderType] = useState<ProviderType>(
        (provider?.provider as ProviderType) ?? "bedrock",
    );

    const meta = PROVIDER_TYPE_META[providerType];

    // Step 2 — credential field values, keyed by field name.
    const [region, setRegion] = useState(provider?.region ?? "us-east-1");
    const [accessKeyId, setAccessKeyId] = useState("");
    const [secretAccessKey, setSecretAccessKey] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [baseUrl, setBaseUrl] = useState(
        provider?.baseUrl ?? PROVIDER_TYPE_META[(provider?.provider as ProviderType) ?? "bedrock"].defaultBaseUrl,
    );

    const [discovered, setDiscovered] = useState<DiscoveredModel[]>(() =>
        // In edit mode, seed the model pickers from the saved record so the user
        // can keep existing models without re-discovering.
        mode === "edit" && provider
            ? provider.models.map((m) => ({
                  id: m.id,
                  name: m.label,
                  capabilities: m.capabilities ?? [],
              }))
            : [],
    );
    /** True once discovery has run in this session (vs. seeded from the record). */
    const [didRediscover, setDidRediscover] = useState(false);
    const [discoverError, setDiscoverError] = useState<string | null>(null);

    // Step 3
    const [chatModel, setChatModel] = useState(provider?.chatModel ?? "");
    const [embeddingModel, setEmbeddingModel] = useState(provider?.embeddingModel ?? "");
    // Embedding dimensions are auto-detected by probing the selected model — not
    // hand-entered — so the stored value always matches what the model emits.
    const [probe, setProbe] = useState<EmbeddingProbeResult | null>(null);
    const [probeError, setProbeError] = useState<string | null>(null);
    const [isDefault, setIsDefault] = useState(provider?.isDefault ?? false);

    const fieldValue = (f: CredentialField): string => {
        switch (f) {
            case "region":
                return region;
            case "accessKeyId":
                return accessKeyId;
            case "secretAccessKey":
                return secretAccessKey;
            case "apiKey":
                return apiKey;
            case "baseUrl":
                return baseUrl;
        }
    };

    const setFieldValue = (f: CredentialField, v: string) => {
        switch (f) {
            case "region":
                return setRegion(v);
            case "accessKeyId":
                return setAccessKeyId(v);
            case "secretAccessKey":
                return setSecretAccessKey(v);
            case "apiKey":
                return setApiKey(v);
            case "baseUrl":
                return setBaseUrl(v);
        }
    };

    const handleTypeChange = (value: string) => {
        const next = value as ProviderType;
        setProviderType(next);
        // Prefill base URL with the new type's default when empty or still a default.
        const isDefaultUrl = PROVIDER_TYPE_ORDER.some(
            (t) => PROVIDER_TYPE_META[t].defaultBaseUrl && PROVIDER_TYPE_META[t].defaultBaseUrl === baseUrl,
        );
        if (!baseUrl || isDefaultUrl) {
            setBaseUrl(PROVIDER_TYPE_META[next].defaultBaseUrl);
        }
    };

    /** Build the credentials object with only the non-empty fields for the type. */
    const buildCredentials = (): ProviderCredentialsInput | undefined => {
        const creds: ProviderCredentialsInput = {};
        for (const f of meta.fields) {
            const v = fieldValue(f).trim();
            if (!v) continue;
            if (f === "apiKey") creds.apiKey = v;
            else if (f === "accessKeyId") creds.accessKeyId = v;
            else if (f === "secretAccessKey") creds.secretAccessKey = v;
            else if (f === "baseUrl") creds.baseUrl = v;
            // region is passed separately, not part of credentials
        }
        return Object.keys(creds).length > 0 ? creds : undefined;
    };

    const credsComplete = meta.required.every((f) => fieldValue(f).trim().length > 0);

    const handleDiscover = async () => {
        setDiscoverError(null);
        try {
            const models = await discoverModels.mutateAsync({
                providerType,
                credentials: buildCredentials() ?? {},
                region: meta.hasRegion ? region.trim() || undefined : undefined,
            });
            setDiscovered(models);
            setDidRediscover(true);
            // Reset stale selections if they're no longer in the discovered set.
            if (chatModel && !models.some((m) => m.id === chatModel)) setChatModel("");
            if (embeddingModel && !models.some((m) => m.id === embeddingModel)) setEmbeddingModel("");
            toast.success(`Discovered ${models.length} model${models.length === 1 ? "" : "s"}.`);
            setStep(2);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to discover models.";
            setDiscoverError(message);
            toast.error(message);
        }
    };

    /** In edit mode with no re-discovery, skip discovery and reuse the saved models. */
    const handleSkipDiscovery = () => {
        setDiscoverError(null);
        setStep(2);
    };

    const chatOptions = useMemo(() => discovered.filter(isChatModel), [discovered]);
    const embeddingOptions = useMemo(() => discovered.filter(isEmbeddingModel), [discovered]);

    // Auto-detect the selected embedding model's effective dimension by probing
    // it (shares the runtime embeddings code path, so what we detect is what gets
    // stored). Re-runs whenever the embedding model or provider type changes.
    useEffect(() => {
        if (!embeddingModel) {
            setProbe(null);
            setProbeError(null);
            return;
        }
        let cancelled = false;
        setProbe(null);
        setProbeError(null);
        probeEmbedding
            .mutateAsync({
                providerType,
                embeddingModel,
                credentials: buildCredentials(),
                region: meta.hasRegion ? region.trim() || undefined : undefined,
                providerId: provider?.id,
            })
            .then((result) => {
                if (!cancelled) setProbe(result);
            })
            .catch((err) => {
                if (!cancelled) setProbeError(err instanceof Error ? err.message : "Failed to detect dimensions.");
            });
        return () => {
            cancelled = true;
        };
        // buildCredentials/probeEmbedding are stable enough; re-probe only on model/type change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [embeddingModel, providerType]);

    const embeddingIncompatible = Boolean(embeddingModel) && (probeError != null || (probe != null && !probe.compatible));
    const embeddingPending = Boolean(embeddingModel) && probeEmbedding.isPending;

    const handleSubmit = async () => {
        if (!chatModel) {
            toast.error("Select a chat model.");
            return;
        }

        if (embeddingModel) {
            if (embeddingPending) {
                toast.error("Detecting embedding dimensions — please wait.");
                return;
            }
            if (embeddingIncompatible || !probe) {
                toast.error(
                    `Embedding model is incompatible (the platform requires ${PLATFORM_EMBEDDING_DIMS}-dim vectors). Choose a ${PLATFORM_EMBEDDING_DIMS}-dim model or set Embedding Model to None.`,
                );
                return;
            }
        }

        // In edit mode with no re-discovery, reuse the provider's existing models.
        const models: ProviderModelEntry[] =
            mode === "edit" && !didRediscover && provider
                ? provider.models
                : discovered.map((m) => ({ id: m.id, label: m.name, capabilities: m.capabilities }));

        const payload: CreateProviderInput = {
            name: name.trim(),
            provider: providerType,
            models,
            chatModel,
            embeddingModel: embeddingModel || undefined,
            embeddingDimensions: embeddingModel && probe ? probe.dimensions ?? undefined : undefined,
            isDefault,
        };

        if (meta.hasRegion && region.trim()) payload.region = region.trim();
        if (meta.fields.includes("baseUrl") && baseUrl.trim()) payload.baseUrl = baseUrl.trim();

        const credentials = buildCredentials();
        if (credentials) payload.credentials = credentials;

        try {
            if (mode === "create") {
                await createProvider.mutateAsync(payload);
                toast.success("Provider created.");
            } else if (provider) {
                await updateProvider.mutateAsync({ id: provider.id, ...payload });
                toast.success("Provider updated.");
            }
            router.push("/app/settings/providers");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to save provider.");
        }
    };

    const discovering = discoverModels.isPending;
    const submitting = createProvider.isPending || updateProvider.isPending;
    const hasSavedCreds = mode === "edit" && Boolean(provider?.credentialsConfigured);

    return (
        <div className="space-y-6">
            {/* Step 1 — Provider Type & Name */}
            {step === 0 && (
                <div className="space-y-4">
                    <h3 className="text-lg font-medium">Step 1: Provider Type &amp; Name</h3>
                    <div className="grid gap-1.5">
                        <Label htmlFor="provider-name">Name</Label>
                        <Input
                            id="provider-name"
                            placeholder="My LLM Provider"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="provider-type">Provider</Label>
                        {mode === "edit" ? (
                            <Input id="provider-type" value={meta.label} disabled readOnly />
                        ) : (
                            <Select value={providerType} onValueChange={handleTypeChange}>
                                <SelectTrigger id="provider-type">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {PROVIDER_TYPE_ORDER.map((t) => (
                                        <SelectItem key={t} value={t}>
                                            {PROVIDER_TYPE_META[t].label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                    </div>
                    <Button onClick={() => setStep(1)} disabled={!name.trim() || !providerType}>
                        Next: Credentials
                    </Button>
                </div>
            )}

            {/* Step 2 — Credentials */}
            {step === 1 && (
                <div className="space-y-4">
                    <h3 className="text-lg font-medium">Step 2: Credentials</h3>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setStep(0)}
                        disabled={discovering}
                        className="mb-2"
                    >
                        <ArrowLeft className="mr-2 size-4" />
                        Back
                    </Button>

                    {hasSavedCreds && (
                        <div className="rounded-md border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
                            Credentials are configured
                            {provider?.credentialsHint ? ` (${provider.credentialsHint})` : ""}. Leave the
                            fields blank to keep them, or re-enter to re-discover models.
                        </div>
                    )}

                    {meta.fields.map((f) => {
                        const fm = FIELD_META[f];
                        const isRequired = meta.required.includes(f);
                        return (
                            <div key={f} className="grid gap-1.5">
                                <Label htmlFor={`cred-${f}`}>
                                    {fm.label}{" "}
                                    <span className="text-muted-foreground">
                                        {isRequired ? "(required)" : "(optional)"}
                                    </span>
                                </Label>
                                <Input
                                    id={`cred-${f}`}
                                    type={fm.type}
                                    placeholder={fm.placeholder}
                                    value={fieldValue(f)}
                                    onChange={(e) => setFieldValue(f, e.target.value)}
                                />
                            </div>
                        );
                    })}

                    {discoverError && <p className="text-sm text-destructive">{discoverError}</p>}

                    <div className="flex items-center gap-2">
                        <Button
                            onClick={handleDiscover}
                            disabled={discovering || (!credsComplete && !hasSavedCreds)}
                        >
                            {discovering ? (
                                <Spinner size="sm" className="mr-2" />
                            ) : (
                                <Sparkles className="mr-2 size-4" />
                            )}
                            Validate &amp; Discover Models
                        </Button>
                        {hasSavedCreds && !didRediscover && (
                            <Button variant="ghost" onClick={handleSkipDiscovery} disabled={discovering}>
                                Skip — keep existing models
                            </Button>
                        )}
                    </div>
                </div>
            )}

            {/* Step 3 — Select Models */}
            {step === 2 && (
                <div className="space-y-4">
                    <h3 className="text-lg font-medium">Step 3: Select Models</h3>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setStep(1)}
                        disabled={submitting}
                        className="mb-2"
                    >
                        <ArrowLeft className="mr-2 size-4" />
                        Back
                    </Button>

                    <div className="grid gap-1.5">
                        <Label htmlFor="chat-model">
                            Chat Model <span className="text-muted-foreground">(required)</span>
                        </Label>
                        <Select value={chatModel} onValueChange={setChatModel}>
                            <SelectTrigger id="chat-model">
                                <SelectValue placeholder="Select chat model" />
                            </SelectTrigger>
                            <SelectContent className="max-h-72 overflow-y-auto">
                                {chatOptions.length === 0 ? (
                                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                                        No chat models discovered.
                                    </div>
                                ) : (
                                    chatOptions.map((m) => (
                                        <SelectItem key={m.id} value={m.id}>
                                            {m.name}
                                        </SelectItem>
                                    ))
                                )}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid gap-1.5">
                        <Label htmlFor="embedding-model">
                            Embedding Model <span className="text-muted-foreground">(optional)</span>
                        </Label>
                        <Select
                            value={embeddingModel || NONE_VALUE}
                            onValueChange={(v) => setEmbeddingModel(v === NONE_VALUE ? "" : v)}
                        >
                            <SelectTrigger id="embedding-model">
                                <SelectValue placeholder="None" />
                            </SelectTrigger>
                            <SelectContent className="max-h-72 overflow-y-auto">
                                <SelectItem value={NONE_VALUE}>None</SelectItem>
                                {embeddingOptions.map((m) => (
                                    <SelectItem key={m.id} value={m.id}>
                                        {m.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {embeddingModel && (
                        <div className="grid gap-1.5">
                            <Label>Embedding Dimensions</Label>
                            {embeddingPending ? (
                                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <Spinner size="sm" /> Detecting dimensions…
                                </p>
                            ) : probeError ? (
                                <p className="text-sm text-destructive">
                                    Could not detect dimensions: {probeError}
                                </p>
                            ) : probe ? (
                                probe.compatible ? (
                                    <p className="text-sm text-emerald-600 dark:text-emerald-400">
                                        Detected {probe.dimensions} dimensions — compatible ✓
                                    </p>
                                ) : (
                                    <p className="text-sm text-amber-600 dark:text-amber-500">
                                        {probe.reason ??
                                            `Incompatible — the platform stores ${probe.required}-dim vectors.`}{" "}
                                        Pick another model or set Embedding Model to None to save.
                                    </p>
                                )
                            ) : null}
                        </div>
                    )}

                    <div className="flex items-center gap-3">
                        <Switch id="set-default" checked={isDefault} onCheckedChange={setIsDefault} />
                        <Label htmlFor="set-default">Set as default provider</Label>
                    </div>

                    <Button
                        onClick={handleSubmit}
                        disabled={submitting || !chatModel || embeddingPending || embeddingIncompatible}
                    >
                        {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
                        {mode === "create" ? "Create Provider" : "Save Changes"}
                    </Button>
                </div>
            )}
        </div>
    );
}
