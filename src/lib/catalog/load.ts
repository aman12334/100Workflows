import "server-only";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildCatalog, type Catalog, type CatalogError, type RawEntry, type Registry } from "./catalog";
import { SharedInputsFileSchema, ToolsFileSchema } from "./schema";

export const CATALOG_ROOT = path.join(process.cwd(), "catalog");
export const CATALOG_DIR = path.join(CATALOG_ROOT, "workflows");

/** Every *.json under `dir`, as paths relative to it ("gtm/market-research.json"). */
async function listJson(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(/*turbopackIgnore: true*/ dir, prefix), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listJson(dir, rel)));
    else if (e.name.endsWith(".json")) out.push(rel);
  }
  return out;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(/*turbopackIgnore: true*/ file, "utf8"));
}

/** Loads catalog/shared-inputs.json and catalog/tools.json. Problems are reported, not thrown. */
export async function loadRegistry(root: string = CATALOG_ROOT): Promise<{ registry: Registry; errors: CatalogError[] }> {
  const errors: CatalogError[] = [];
  const registry: Registry = { sharedInputs: [], tools: [] };

  const read = async <T>(name: string, parse: (data: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }) => {
    try {
      const parsed = parse(await readJson(path.join(/*turbopackIgnore: true*/ root, name)));
      if (parsed.success) return parsed.data;
      for (const i of parsed.error.issues) errors.push({ file: name, message: `${i.path.join(".") || "(root)"}: ${i.message}` });
    } catch (err) {
      errors.push({ file: name, message: `cannot read: ${(err as Error).message}` });
    }
    return null;
  };

  registry.sharedInputs = (await read("shared-inputs.json", (d) => SharedInputsFileSchema.safeParse(d)))?.inputs ?? [];
  registry.tools = (await read("tools.json", (d) => ToolsFileSchema.safeParse(d)))?.tools ?? [];
  return { registry, errors };
}

/**
 * Reads every definition under catalog/workflows/<category>/. The catalog is
 * small and local, so it is re-read on each call: contributors see edits without
 * restarting. It lives next to the app at runtime, so the reads are excluded
 * from build tracing.
 */
export async function loadCatalog(dir: string = CATALOG_DIR, root: string = path.dirname(dir)): Promise<Catalog> {
  const { registry, errors: registryErrors } = await loadRegistry(root);
  let files: string[];
  try {
    files = await listJson(dir);
  } catch (err) {
    return { workflows: [], sources: {}, registry, errors: [{ file: dir, message: `cannot read catalog directory: ${(err as Error).message}` }] };
  }

  const entries: RawEntry[] = [];
  const parseErrors: CatalogError[] = [];
  for (const file of files) {
    if (!file.includes("/")) {
      parseErrors.push({ file, message: "definitions live in a category folder, e.g. catalog/workflows/gtm/<id>.json" });
      continue;
    }
    try {
      entries.push({ file, data: await readJson(path.join(/*turbopackIgnore: true*/ dir, file)) });
    } catch (err) {
      parseErrors.push({ file, message: `invalid JSON: ${(err as Error).message}` });
    }
  }

  const catalog = buildCatalog(entries, registry);
  return { ...catalog, errors: [...registryErrors, ...parseErrors, ...catalog.errors] };
}
