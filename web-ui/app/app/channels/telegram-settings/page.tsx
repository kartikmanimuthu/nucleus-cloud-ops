'use client';

import { TelegramSettingsForm } from '@/components/channels/telegram-settings-form';

export default function ChannelsTelegramSettingsPage() {
    return <TelegramSettingsForm backHref="/channels" backLabel="Back to Channels" />;
}
