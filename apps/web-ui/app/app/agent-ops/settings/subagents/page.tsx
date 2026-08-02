'use client';

import { AiopsSubagentSettings } from '@/components/settings/aiops-subagent-settings';
import { AiopsFeatureSettings } from '@/components/settings/aiops-feature-settings';

export default function AiopsSubagentSettingsPage() {
  return (
    <div className="flex-1 space-y-6 bg-background p-6">
      <AiopsFeatureSettings />
      <AiopsSubagentSettings />
    </div>
  );
}
