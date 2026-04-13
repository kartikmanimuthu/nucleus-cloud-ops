import type { Metadata } from 'next';
import { CloudShellPage } from '@/components/cloud-shell/cloud-shell-page';

export const metadata: Metadata = {
    title: 'Cloud Shell — Nucleus',
    description: 'Browser-based AWS terminal',
};

export default function CloudShellRoute() {
    return (
        <>
            {/* xterm.js styles — loaded once at page level */}
            {/* eslint-disable-next-line @next/next/no-css-tags */}
            <link
                rel="stylesheet"
                href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.css"
            />
            <div className="h-[calc(100vh-4rem)] flex flex-col">
                <CloudShellPage />
            </div>
        </>
    );
}
