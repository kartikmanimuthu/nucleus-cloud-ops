import { Suspense } from "react";
import { Metadata } from "next";
import { RecommendationDetailPage } from "@/components/right-sizing/recommendation-detail-page";

interface RightSizingDetailRouteProps {
    params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: RightSizingDetailRouteProps): Promise<Metadata> {
    const { id } = await params;
    return { title: `Right Sizing — ${id.slice(0, 8)}` };
}

export default async function RightSizingDetailRoute({ params }: RightSizingDetailRouteProps) {
    const { id } = await params;
    return (
        <Suspense fallback={null}>
            <RecommendationDetailPage recommendationId={id} />
        </Suspense>
    );
}
