import "server-only";
import { loadCatalog } from "@/lib/catalog/load";
import type { Category } from "@/lib/catalog/schema";
import { getModelConfig } from "./config";

/** Props every chat page needs: config status (never the key) and catalog facts. */
export async function chatPageProps() {
  const catalog = await loadCatalog();
  const config = getModelConfig();
  const categoryCounts: Partial<Record<Category, number>> = {};
  for (const w of catalog.workflows) categoryCounts[w.category] = (categoryCounts[w.category] ?? 0) + 1;
  return {
    configured: config.configured,
    configProblem: config.problem,
    providerLabel: config.providerLabel,
    catalogSize: catalog.workflows.length,
    categoryCounts,
    workflowNames: Object.fromEntries(catalog.workflows.map((w) => [w.id, w.name])),
  };
}
