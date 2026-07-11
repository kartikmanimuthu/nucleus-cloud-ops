'use client';

import { SlackSettingsForm } from '@/components/channels/slack-settings-form';

export default function SlackSettingsPage() {
    return <SlackSettingsForm backHref="/app/channels" backLabel="Back to Channels" />;
}
