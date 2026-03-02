import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Deep Agent | Nucleus Cloud Ops',
  description: 'AI-powered cloud operations with Deep Agent — subagents, human-in-the-loop, and long-term memory',
};

export default function DeepAgentLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
