"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff } from "lucide-react";

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

export function CertificateDetailTab({ certificateId }: CertificateDetailTabProps) {
    const [detail, setDetail] = useState<CertificateDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [showBody, setShowBody] = useState(false);
    const [showKey, setShowKey] = useState(false);

    useEffect(() => {
        async function fetchDetail() {
            try {
                const res = await fetch(`/api/certificates/${certificateId}`);
                const json = await res.json();
                if (json.success) {
                    setDetail(json.data);
                }
            } catch (e) {
                console.error('Failed to fetch certificate detail:', e);
            } finally {
                setLoading(false);
            }
        }
        fetchDetail();
    }, [certificateId]);

    if (loading) {
        return <div className="p-4 text-muted-foreground">Loading...</div>;
    }

    if (!detail) {
        return <div className="p-4 text-muted-foreground">Certificate not found</div>;
    }

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
            <div>
                <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-muted-foreground">Certificate Body</span>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setShowBody(v => !v)}
                    >
                        {showBody ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                </div>
                <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-h-48 font-mono">
                    {showBody ? "(certificate content from S3)" : "*".repeat(80)}
                </pre>
            </div>

            {/* Private Key */}
            <div>
                <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-muted-foreground">Private Key</span>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setShowKey(v => !v)}
                    >
                        {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                </div>
                <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-h-48 font-mono">
                    {showKey ? "(private key content from S3)" : "*".repeat(80)}
                </pre>
            </div>

            {/* Certificate Chain */}
            {detail.s3ChainKey && (
                <div>
                    <span className="text-sm text-muted-foreground">Certificate Chain</span>
                    <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-h-48 font-mono mt-1">
                        (chain content from S3)
                    </pre>
                </div>
            )}
        </div>
    );
}
