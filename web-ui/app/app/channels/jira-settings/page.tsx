'use client';

import { JiraSettingsForm } from '@/components/channels/jira-settings-form';

export default function ChannelsJiraSettingsPage() {
    return <JiraSettingsForm backHref="/app/channels" backLabel="Back to Channels" />;
}
