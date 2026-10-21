import type { Metadata } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@fontsource-variable/outfit";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job Outreach Assistant",
  description:
    "Chat-driven outreach for job applications — find the right people with CleanList and email them via Composio.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html className="h-full antialiased" lang="en">
      <body className="min-h-full flex flex-col">
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      </body>
    </html>
  );
}