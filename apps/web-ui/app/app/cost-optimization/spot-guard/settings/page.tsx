'use client';

import { Settings } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { SpotGuardSettingsForm } from '@/components/spot-guard/settings-form';

export default function SpotGuardSettingsPage() {
    return (
        <div className="space-y-6 p-6">
            <PageHeader
                icon={Settings}
                title="Spot Guard settings"
                description="Where Spot Guard posts its alerts, and which day its report covers."
            />
            <SpotGuardSettingsForm />
        </div>
    );
}
