import { requireAuth } from '@/components/auth/AuthorizePage';

export default async function CloudShellLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    await requireAuth('read', 'ShellSession');
    return <>{children}</>;
}
