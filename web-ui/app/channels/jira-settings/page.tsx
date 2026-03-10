'use client';

import { JiraSettingsForm } from '@/components/channels/jira-settings-form';

export default function ChannelsJiraSettingsPage() {
    return <JiraSettingsForm backHref="/channels" backLabel="Back to Channels" />;
}
