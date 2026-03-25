import { source } from "@/lib/docs-source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { Zap } from "lucide-react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <span className="flex items-center gap-2 font-bold">
            <Zap className="w-4 h-4 text-primary" />
            Nucleus Ops
          </span>
        ),
        url: "/",
      }}
      links={[
        { text: "Home", url: "/" },
        { text: "Dashboard", url: "/dashboard" },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
