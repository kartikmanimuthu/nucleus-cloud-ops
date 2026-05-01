import { Metadata } from "next";
import { CertificateClientComponent } from "@/components/certificates/certificate-client-component";

export const metadata: Metadata = {
    title: "Certificate Manager — Nucleus",
};

export default function CertificatesPage() {
    return <CertificateClientComponent />;
}
