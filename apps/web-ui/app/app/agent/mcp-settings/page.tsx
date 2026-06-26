'use client';

import { MCPSettings } from '@/components/settings/mcp-settings';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';

export default function MCPSettingsPage() {
  const router = useRouter();

  return (
    <div className="flex-1 bg-background max-w-4xl mx-auto">
      {/* Back navigation */}
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-muted-foreground hover:text-foreground -ml-2"
          onClick={() => router.push('/app/agent')}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Agent
        </Button>
      </div>

      {/* MCP Settings Component */}
      <MCPSettings />
    </div>
  );
}
