"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, Copy, Check } from "lucide-react";
import { useCertificate, useCertificateContent } from "@/lib/queries/certificates";

interface CertificateDetailTabProps {
    certificateId: string;
}

export function CertificateDetailTab({ certificateId }: CertificateDetailTabProps) {
    const { data: detail, isLoading } = useCertificate(certificateId);
    const { data: content } = useCertificateContent(certificateId);
    const [showBody, setShowBody] = useState(false);
    const [showKey, setShowKey] = useState(false);
    const [showChain, setShowChain] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);

    const handleCopy = async (text: string, label: string) => {
        await navigator.clipboard.writeText(text);
        setCopied(label);
        setTimeout(() => setCopied(null), 2000);
    };

    if (isLoading) {
        return <div className="p-4 text-muted-foreground">Loading...</div>;
    }

    if (!detail) {
        return <div className="p-4 text-muted-foreground">Certificate not found</div>;
    }

    const renderBlock = (
        label: string,
        value: string | undefined | null,
        visible: boolean,
        setVisible: (v: boolean) => void,
        copyLabel: string,
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
                        {visible ? (
                            <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                            <Eye className="h-3.5 w-3.5" />
                        )}
                    </Button>
                </div>
            </div>
            <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-h-48 font-mono">
                {visible ? value || "No content available" : "*".repeat(80)}
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
                        {detail.notAfter
                            ? new Date(detail.notAfter).toLocaleDateString()
                            : "—"}
                    </p>
                </div>
            </div>

            {renderBlock("Certificate Body", content?.body, showBody, setShowBody, "body")}
            {renderBlock("Private Key", content?.privateKey, showKey, setShowKey, "key")}
            {content?.chain &&
                renderBlock(
                    "Certificate Chain",
                    content?.chain,
                    showChain,
                    setShowChain,
                    "chain",
                )}
        </div>
    );
}
