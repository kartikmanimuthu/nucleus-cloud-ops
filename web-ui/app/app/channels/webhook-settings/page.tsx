'use client';

import { WebhookSettingsForm } from '@/components/channels/webhook-settings-form';

export default function ChannelsWebhookSettingsPage() {
    return <WebhookSettingsForm backHref="/channels" backLabel="Back to Channels" />;
}
