import Link from 'next/link';
import { ArrowUpRight, BookOpenText } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface SetupGuideLinkProps {
    href: string;
    description: string;
}

/**
 * Points channel settings pages at the full step-by-step guide rendered in
 * the in-app docs site, instead of duplicating the steps inline here.
 */
export function SetupGuideLink({ href, description }: SetupGuideLinkProps) {
    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">Step-by-step Setup Guide</CardTitle>
                <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent>
                <Link
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-500 hover:underline"
                >
                    <BookOpenText className="h-4 w-4" />
                    Open the full setup guide
                    <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
            </CardContent>
        </Card>
    );
}
