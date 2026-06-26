'use client';

import { TelegramSettingsForm } from '@/components/channels/telegram-settings-form';

export default function ChannelsTelegramSettingsPage() {
    return <TelegramSettingsForm backHref="/app/channels" backLabel="Back to Channels" />;
}
