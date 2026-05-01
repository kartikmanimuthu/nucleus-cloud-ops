"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { CertificateDetailTab } from "./certificate-detail-tab";
import { CertificateAccountsTab } from "./certificate-accounts-tab";
import { CertificateResourcesTab } from "./certificate-resources-tab";
import type { CertificateRow } from "./certificate-grid";
import { useState } from "react";

interface CertificateSidePanelProps {
    certificate: CertificateRow;
    onClose: () => void;
    onReimport: (certId: string, accountId: string) => Promise<void>;
}

export function CertificateSidePanel({
    certificate,
    onClose,
    onReimport,
}: CertificateSidePanelProps) {
    const [reimporting, setReimporting] = useState<string | null>(null);

    const handleReimport = async (accountId: string) => {
        setReimporting(accountId);
        try {
            await onReimport(certificate.id, accountId);
        } finally {
            setReimporting(null);
        }
    };

    return (
        <div className="w-96 border-l bg-background flex flex-col h-full overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
                <div>
                    <h2 className="font-semibold text-sm">{certificate.name}</h2>
                    <p className="text-xs text-muted-foreground font-mono">
                        {certificate.domainName}
                    </p>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
                    <X className="h-4 w-4" />
                </Button>
            </div>

            <div className="flex-1 overflow-y-auto">
                <Tabs defaultValue="details" className="w-full">
                    <TabsList className="w-full rounded-none border-b bg-transparent h-10 px-4">
                        <TabsTrigger value="details" className="text-xs">
                            Details
                        </TabsTrigger>
                        <TabsTrigger value="accounts" className="text-xs">
                            Accounts ({certificate.associatedAccountIds.length})
                        </TabsTrigger>
                        <TabsTrigger value="resources" className="text-xs">
                            Resources
                        </TabsTrigger>
                    </TabsList>
                    <div className="p-4">
                        <TabsContent value="details">
                            <CertificateDetailTab certificateId={certificate.id} />
                        </TabsContent>
                        <TabsContent value="accounts">
                            <CertificateAccountsTab
                                certificateId={certificate.id}
                                onReimport={handleReimport}
                                reimporting={reimporting}
                            />
                        </TabsContent>
                        <TabsContent value="resources">
                            <CertificateResourcesTab certificateId={certificate.id} />
                        </TabsContent>
                    </div>
                </Tabs>
            </div>
        </div>
    );
}
