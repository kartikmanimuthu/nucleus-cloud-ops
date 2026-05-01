import { Metadata } from "next";
import { CertificateDetailPage } from "@/components/certificates/certificate-detail-page";

interface CertificateDetailRouteProps {
    params: Promise<{
        id: string;
    }>;
}

export async function generateMetadata({ params }: CertificateDetailRouteProps): Promise<Metadata> {
    const { id } = await params;
    return {
        title: `Certificate — ${id.slice(0, 8)}`,
    };
}

export default async function CertificateDetailRoute({ params }: CertificateDetailRouteProps) {
    const { id } = await params;
    return <CertificateDetailPage certificateId={id} />;
}
