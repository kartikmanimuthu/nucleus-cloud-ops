'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

/**
 * Fires a toast for OAuth callback results (?connected=1 / ?bot_installed=1 /
 * ?error=...) then strips the query params. Rendered on each connector
 * settings page.
 */
export function ConnectorCallbackToast({ displayName }: { displayName: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    const connected = params.get('connected');
    const botInstalled = params.get('bot_installed');
    const error = params.get('error');
    if (!connected && !botInstalled && !error) return;
    fired.current = true;

    if (error) toast.error(`${displayName}: ${decodeURIComponent(error)}`);
    else if (botInstalled) toast.success(`${displayName} workspace bot installed`);
    else if (connected) toast.success(`${displayName} account connected`);

    router.replace(window.location.pathname);
  }, [params, router, displayName]);

  return null;
}
