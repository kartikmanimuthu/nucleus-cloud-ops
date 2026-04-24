import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { OrganizationSettingsForm } from "@/components/settings/organization-settings-form";
import { SchedulerSettings } from "@/components/settings/scheduler-settings";
import { DiscoverySettings } from "@/components/settings/discovery-settings";

export default async function OrganizationSettingsPage() {
    const session = await getServerSession(authOptions);
    const role = (session?.user as { role?: string } | undefined)?.role;
    const isSuperAdmin = (session?.user as { isSuperAdmin?: boolean } | undefined)?.isSuperAdmin;
    const canEdit = role === 'Owner' || role === 'Admin' || isSuperAdmin === true;

    return (
        <div className="space-y-6">
            <OrganizationSettingsForm />
            <SchedulerSettings canEdit={canEdit} />
            <DiscoverySettings canEdit={canEdit} />
        </div>
    );
}
