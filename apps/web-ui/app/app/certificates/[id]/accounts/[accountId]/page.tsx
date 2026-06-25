import { Metadata } from "next";
import { CertificateAccountDetailPage } from "@/components/certificates/certificate-account-detail-page";

interface CertificateAccountDetailRouteProps {
    params: Promise<{
        id: string;
        accountId: string;
    }>;
}

export async function generateMetadata({ params }: CertificateAccountDetailRouteProps): Promise<Metadata> {
    const { id, accountId } = await params;
    return {
        title: `Certificate — ${id.slice(0, 8)} — ${accountId}`,
    };
}

export default async function CertificateAccountDetailRoute({ params }: CertificateAccountDetailRouteProps) {
    const { id, accountId } = await params;
    return <CertificateAccountDetailPage certificateId={id} accountId={accountId} />;
}
