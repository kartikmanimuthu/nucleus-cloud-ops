"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, Copy, Check } from "lucide-react";

interface CertificateDetailTabProps {
    certificateId: string;
}

interface CertificateDetail {
    name: string;
    domainName: string;
    status: string;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string;
    s3BodyKey: string;
    s3ChainKey: string | null;
    s3PrivateKeyKey: string;
}

interface CertificateContent {
    body: string;
    chain?: string;
    privateKey: string;
}

export function CertificateDetailTab({ certificateId }: CertificateDetailTabProps) {
    const [detail, setDetail] = useState<CertificateDetail | null>(null);
    const [content, setContent] = useState<CertificateContent | null>(null);
    const [loading, setLoading] = useState(true);
    const [showBody, setShowBody] = useState(false);
    const [showKey, setShowKey] = useState(false);
    const [showChain, setShowChain] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);

    useEffect(() => {
        async function fetchData() {
            try {
                const [metaRes, contentRes] = await Promise.all([
                    fetch(`/api/certificates/${certificateId}`),
                    fetch(`/api/certificates/${certificateId}/content`),
                ]);
                const metaJson = await metaRes.json();
                const contentJson = await contentRes.json();
                if (metaJson.success) {
                    setDetail(metaJson.data);
                }
                if (contentJson.success) {
                    setContent(contentJson.data);
                }
            } catch (e) {
                console.error('Failed to fetch certificate detail:', e);
            } finally {
                setLoading(false);
            }
        }
        fetchData();
    }, [certificateId]);

    const handleCopy = async (text: string, label: string) => {
        await navigator.clipboard.writeText(text);
        setCopied(label);
        setTimeout(() => setCopied(null), 2000);
    };

    if (loading) {
        return <div className="p-4 text-muted-foreground">Loading...</div>;
    }

    if (!detail) {
        return <div className="p-4 text-muted-foreground">Certificate not found</div>;
    }

    const renderBlock = (
        label: string,
        value: string | undefined,
        visible: boolean,
        setVisible: (v: boolean) => void,
        copyLabel: string
    ) => (
        <div>
            <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-muted-foreground">{label}</span>
                <div className="flex items-center gap-1">
                    {value && visible && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => handleCopy(value, copyLabel)}
                        >
                            {copied === copyLabel ? (
                                <Check className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                                <Copy className="h-3.5 w-3.5" />
                            )}
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setVisible(!visible)}
                    >
                        {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                </div>
            </div>
            <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-h-48 font-mono">
                {visible ? (value || "No content available") : "*".repeat(80)}
            </pre>
        </div>
    );

    return (
        <div className="space-y-4 p-1">
            <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                    <span className="text-muted-foreground">Domain</span>
                    <p className="font-mono">{detail.domainName}</p>
                </div>
                <div>
                    <span className="text-muted-foreground">Issuer</span>
                    <p>{detail.issuer || "Unknown"}</p>
                </div>
                <div>
                    <span className="text-muted-foreground">Valid From</span>
                    <p className="font-mono text-sm">
                        {detail.notBefore
                            ? new Date(detail.notBefore).toLocaleDateString()
                            : "—"}
                    </p>
                </div>
                <div>
                    <span className="text-muted-foreground">Expires</span>
                    <p className="font-mono text-sm">
                        {new Date(detail.notAfter).toLocaleDateString()}
                    </p>
                </div>
            </div>

            {/* Certificate Body */}
            {renderBlock(
                "Certificate Body",
                content?.body,
                showBody,
                setShowBody,
                "body"
            )}

            {/* Private Key */}
            {renderBlock(
                "Private Key",
                content?.privateKey,
                showKey,
                setShowKey,
                "key"
            )}

            {/* Certificate Chain */}
            {detail.s3ChainKey && renderBlock(
                "Certificate Chain",
                content?.chain,
                showChain,
                setShowChain,
                "chain"
            )}
        </div>
    );
}
