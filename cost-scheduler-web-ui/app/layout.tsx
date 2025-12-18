import type React from "react";
import type { Metadata } from "next";
import { Inter, Manrope } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeConfigProvider } from "@/components/theme-config-provider";
import { Toaster } from "@/components/ui/toaster";
import { LayoutWrapper } from "@/components/layout-wrapper";
import Providers from "@/providers/Providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });

export const metadata: Metadata = {
  title: "Cost Optimization Scheduler",
  description:
    "AWS Cost Optimization Scheduler - Manage resource schedules across multiple accounts",
  generator: "v0.dev",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${manrope.variable} font-sans overflow-y-hidden`}>
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
                <Toaster />
              </div>
            </ThemeConfigProvider>
          </ThemeProvider>
        </Providers>
      </body>
    </html>
  );
}
