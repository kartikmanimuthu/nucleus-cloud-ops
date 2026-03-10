'use client';

import { SlackSettingsForm } from '@/components/channels/slack-settings-form';

export default function SlackSettingsPage() {
    return <SlackSettingsForm backHref="/agent-ops" backLabel="Back to Agent Ops" />;
}
