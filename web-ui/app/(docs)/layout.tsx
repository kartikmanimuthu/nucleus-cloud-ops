import { RootProvider } from "fumadocs-ui/provider";
import type { ReactNode } from "react";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider>
      <style>{`
        :root {
          --fd-primary: 221.2 83.2% 53.3%;
          --fd-primary-foreground: 210 40% 98%;
        }
        .dark {
          --fd-primary: 217.2 91.2% 59.8%;
          --fd-primary-foreground: 222.2 84% 4.9%;
        }
      `}</style>
      {children}
    </RootProvider>
  );
}
