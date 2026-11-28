import type { Metadata } from "next";
import { Host_Grotesk, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { AppShell, type ShellData } from "@/components/shell/app-shell";
import { accessToken } from "@/lib/auth";
import { capabilityOf } from "@/lib/catalog/capability";
import { loadAppCatalog } from "@/lib/catalog/load";
import { CATEGORY_LABELS, type Category } from "@/lib/catalog/schema";
import { getModelConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { listPackages } from "@/lib/server/db/packages";
import { listRuns } from "@/lib/server/db/runs";
import "./globals.css";

const hostGrotesk = Host_Grotesk({ subsets: ["latin"], variable: "--font-host-grotesk", display: "swap" });
const instrumentSans = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument-sans", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "100 Workflows",
  description: "Describe a business problem, discover agentic workflows that solve it, and run them.",
};

export const dynamic = "force-dynamic";

/** Sidebar order: the seven business areas, then the three execution types that need more than a model. */
const CATEGORY_ORDER: Category[] = ["gtm", "marketing", "sales", "finance", "user-research", "product", "operations"];
const TYPES = [
  { id: "research", label: "Research" },
  { id: "calculation", label: "Calculations" },
  { id: "integration", label: "Integrations" },
] as const;

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Only non-secret facts cross into client components: whether a key is set, and which model.
  const config = getModelConfig();
  const db = getDb();
  const { workflows } = await loadAppCatalog();
  const packages = listPackages(db);
  const data: ShellData = {
    total: workflows.length,
    categories: CATEGORY_ORDER.map((c) => ({ id: c, label: CATEGORY_LABELS[c], count: workflows.filter((w) => w.category === c).length })),
    types: TYPES.map((t) => ({ ...t, count: workflows.filter((w) => capabilityOf(w) === t.id).length })),
    saved: packages.slice(0, 5).map((p) => ({ id: p.id, name: p.name })),
    savedCount: packages.length,
    recentRuns: listRuns(db, { limit: 4 }).map((r) => ({ id: r.id, label: r.packageName, status: r.status })),
    model: { configured: config.configured, name: config.model },
    signedIn: accessToken() !== null,
  };
  return (
    <html lang="en" className={`${hostGrotesk.variable} ${instrumentSans.variable} ${jetbrains.variable}`}>
      {/* Browser extensions (e.g. Grammarly) add attributes to <body> before React loads; ignore only that. */}
      <body className="font-sans" suppressHydrationWarning>
        <AppShell data={data}>{children}</AppShell>
      </body>
    </html>
  );
}
