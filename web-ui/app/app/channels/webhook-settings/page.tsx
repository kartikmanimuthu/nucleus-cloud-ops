'use client';

import { WebhookSettingsForm } from '@/components/channels/webhook-settings-form';

export default function ChannelsWebhookSettingsPage() {
    return <WebhookSettingsForm backHref="/app/channels" backLabel="Back to Channels" />;
}
