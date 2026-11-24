import "server-only";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Workflow } from "@/lib/catalog/schema";
import { lookupCalculation } from "@/lib/runtime/calc/runner";
import { TOOLS } from "@/lib/runtime/tools/registry";
import { definitionHash } from "@/lib/server/db/packages";
import type { WorkflowProfile } from "@/lib/quality/profile";
import type { ExecutionType, Fingerprint } from "@/lib/quality/types";

/**
 * What a piece of evidence was about. Evidence goes stale when any part changes:
 * - the definition (prompts, output schema, rules and their parameters, limits);
 * - the runtime source files relevant to the workflow's execution type;
 * - versioned components: tools, the calculation, provider actions, the golden dataset.
 * Only relevant code counts, so editing the calculation layer doesn't invalidate research evidence.
 */

const SRC = path.join(process.cwd(), "src", "lib");
const COMMON = ["runtime/engine.ts", "runtime/budget.ts", "runtime/evaluation.ts", "runtime/model.ts", "runtime/openai-translate.ts", "runtime/rules", "runtime/executors/generic.ts", "runtime/executors/index.ts", "runtime/executors/shared.ts", "catalog/schema.ts", "catalog/output-schema.ts", "packages/inputs.ts", "server/run-service.ts", "server/model-client.ts", "server/claude.ts", "server/openai.ts"];
export const CODE_GROUPS: Record<ExecutionType | "platform", string[]> = {
  model: COMMON,
  multi_agent: COMMON,
  research: [...COMMON, "runtime/tools", "runtime/executors/research.ts"],
  calculation: [...COMMON, "runtime/calc", "runtime/executors/calculation.ts"],
  integration: [...COMMON, "integrations", "runtime/executors/integration.ts", "server/action-service.ts", "server/db/actions.ts"],
  platform: ["request-guard.ts", "auth.ts", "../proxy.ts", "server/db", "files", "server/workspace.ts", "server/log.ts", "quality", "server/quality", "../app/api/health/route.ts"],
};

function files(rel: string): string[] {
  const abs = path.join(SRC, rel);
  try {
    if (statSync(/*turbopackIgnore: true*/ abs).isDirectory()) return readdirSync(/*turbopackIgnore: true*/ abs).flatMap((f) => files(path.join(rel, f)));
    return /\.(ts|tsx)$/.test(abs) ? [rel] : [];
  } catch {
    return [];
  }
}

const cache = new Map<string, string>();
/** sha256 over the listed source files (path and content), sorted. Cached per process. */
export function codeHash(group: ExecutionType | "platform", extra: string[] = []): string {
  const key = `${group}|${extra.join(",")}`;
  if (!cache.has(key)) {
    const h = createHash("sha256");
    for (const f of [...new Set([...CODE_GROUPS[group], ...extra].flatMap(files))].sort()) h.update(f).update("\0").update(readFileSync(/*turbopackIgnore: true*/ path.join(SRC, f))).update("\0");
    cache.set(key, h.digest("hex"));
  }
  return cache.get(key)!;
}
export const clearFingerprintCache = () => cache.clear();

export function workflowFingerprint(wf: Workflow, profile: WorkflowProfile, goldenVersion: number | null): Fingerprint {
  const components = [
    ...profile.tools.map((t) => `${t}@${TOOLS[t]?.version ?? "?"}`),
    ...(profile.usesWebSearch && !profile.tools.includes("web-search") ? [`web-search@${TOOLS["web-search"]?.version ?? "?"}`] : []),
    ...(profile.usesWebFetch && !profile.tools.includes("web-fetch") ? [`web-fetch@${TOOLS["web-fetch"]?.version ?? "?"}`] : []),
    ...(profile.calculation ? [`calc:${profile.calculation}${lookupCalculation(profile.calculation) ? "" : "(unregistered)"}`] : []),
    ...profile.actions.map((a) => `action:${a}`),
    ...(goldenVersion ? [`golden@${goldenVersion}`] : []),
  ].sort();
  return { definition: definitionHash(wf), code: codeHash(profile.executionType, profile.handWritten ? [`runtime/executors/${wf.id}.ts`] : []), components };
}

export const platformFingerprint = (): Fingerprint => ({ definition: "*", code: codeHash("platform"), components: [] });
