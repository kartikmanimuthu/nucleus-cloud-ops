import type React from "react";
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeConfigProvider } from "@/components/theme-config-provider";
import { Toaster as SonnerToaster } from "sonner";
import { LayoutWrapper } from "@/components/layout-wrapper";
import Providers from "@/providers/Providers";

export const metadata: Metadata = {
  title: "Nucleus Cloud Ops",
  description:
    "Nucleus Cloud Ops - Manage AWS resources, schedules and costs across multiple accounts",
  generator: "v0.dev",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${GeistSans.variable} ${GeistMono.variable} font-sans`}>
        <Providers>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <ThemeConfigProvider>
              <div>
                <LayoutWrapper>{children}</LayoutWrapper>
                <SonnerToaster richColors position="bottom-right" />
              </div>
            </ThemeConfigProvider>
          </ThemeProvider>
        </Providers>
      </body>
    </html>
  );
}
