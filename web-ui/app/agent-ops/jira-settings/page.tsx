'use client';

import { JiraSettingsForm } from '@/components/channels/jira-settings-form';

export default function JiraSettingsPage() {
    return <JiraSettingsForm backHref="/agent-ops" backLabel="Back to Agent Ops" />;
}
