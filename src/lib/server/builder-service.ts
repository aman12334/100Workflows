import "server-only";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { BuilderSpecSchema, definitionFromSpec } from "@/lib/catalog/builder";
import { buildCatalog, validateGenericDefinition } from "@/lib/catalog/catalog";
import { CUSTOM_PREFIX, customDir, loadAppCatalog, loadRegistry } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";

export interface BuildResult {
  ok: boolean;
  problems: string[];
  definition: Record<string, unknown> | null;
  workflow?: Workflow;
}

/** Validates a builder spec exactly as a catalog definition would be validated. Nothing is written. */
export async function validateBuilderSpec(spec: unknown, opts: { allowReplaceCustom?: boolean } = {}): Promise<BuildResult> {
  const parsed = BuilderSpecSchema.safeParse(spec);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`), definition: null };
  const definition = definitionFromSpec(parsed.data);
  const problems: string[] = [];
  const app = await loadAppCatalog();
  const owner = app.sources[parsed.data.id];
  if (owner && !(owner.startsWith(CUSTOM_PREFIX) && opts.allowReplaceCustom)) problems.push(owner.startsWith(CUSTOM_PREFIX) ? `a custom workflow "${parsed.data.id}" already exists` : `"${parsed.data.id}" is a catalog workflow id; choose another`);
  const { registry } = await loadRegistry();
  const built = buildCatalog([{ file: `${CUSTOM_PREFIX}${parsed.data.category}/${parsed.data.id}.json`, data: definition }], registry);
  problems.push(...built.errors.map((e) => e.message));
  const workflow = built.workflows[0];
  if (workflow) problems.push(...validateGenericDefinition(workflow));
  return { ok: problems.length === 0, problems: [...new Set(problems)], definition, workflow };
}

const fileFor = (dir: string, category: string, id: string) => {
  const file = path.join(dir, category, `${id}.json`);
  if (!file.startsWith(dir + path.sep)) throw new Error("invalid path");
  return file;
};

/** Saves a valid spec as data/custom-workflows/<category>/<id>.json (atomic write). */
export async function saveBuilderSpec(spec: unknown, opts: { allowReplaceCustom?: boolean } = {}): Promise<BuildResult & { file?: string }> {
  const dir = customDir();
  if (!dir) return { ok: false, problems: ["Custom workflows are turned off (WORKFLOWS_CUSTOM_DIR=off)."], definition: null };
  const result = await validateBuilderSpec(spec, opts);
  if (!result.ok || !result.workflow) return result;
  const wf = result.workflow;
  // Replacing may move the workflow to another category: remove the old file first.
  for (const cat of await readdir(dir).catch(() => [] as string[])) {
    if (cat !== wf.category) await unlink(fileFor(dir, cat, wf.id)).catch(() => undefined);
  }
  const file = fileFor(dir, wf.category, wf.id);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(result.definition, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return { ...result, file: path.relative(process.cwd(), file) };
}

export async function deleteCustomWorkflow(id: string): Promise<boolean> {
  const dir = customDir();
  if (!dir || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return false;
  for (const cat of await readdir(dir).catch(() => [] as string[])) {
    try {
      await unlink(fileFor(dir, cat, id));
      return true;
    } catch {
      // not in this category
    }
  }
  return false;
}
