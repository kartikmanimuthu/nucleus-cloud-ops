'use client';

import { DiscordSettingsForm } from '@/components/channels/discord-settings-form';

export default function ChannelsDiscordSettingsPage() {
    return <DiscordSettingsForm backHref="/app/channels" backLabel="Back to Channels" />;
}
