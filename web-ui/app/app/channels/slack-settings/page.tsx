'use client';

import { SlackSettingsForm } from '@/components/channels/slack-settings-form';

export default function ChannelsSlackSettingsPage() {
    return <SlackSettingsForm backHref="/channels" backLabel="Back to Channels" />;
}
