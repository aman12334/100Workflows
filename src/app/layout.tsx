import type { Metadata } from "next";
import { Bricolage_Grotesque, Inter, JetBrains_Mono } from "next/font/google";
import { Sidebar } from "@/components/sidebar";
import { getModelConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { listConversations } from "@/lib/server/db/conversations";
import { listPackages } from "@/lib/server/db/packages";
import "./globals.css";

const bricolage = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "100 Workflows",
  description: "Describe a business problem, discover agentic workflows that solve it.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Only non-secret facts cross into client components: whether a key is set, and which model.
  const config = getModelConfig();
  const db = getDb();
  const recent = listConversations(db, 6).map((c) => ({ id: c.id, title: c.title }));
  const packageCount = listPackages(db).length;
  return (
    <html lang="en" className={`${bricolage.variable} ${inter.variable} ${jetbrains.variable}`}>
      <body className="font-sans">
        <div className="flex min-h-dvh flex-col lg:flex-row">
          <Sidebar configured={config.configured} model={config.model} recent={recent} packageCount={packageCount} />
          <main className="bg-dots relative min-w-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
