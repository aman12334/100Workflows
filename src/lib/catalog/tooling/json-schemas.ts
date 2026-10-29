import { z } from "zod";
import { ManifestSchema, SharedInputsFileSchema, ToolsFileSchema } from "../schema";

/**
 * JSON Schemas for editors, generated from the Zod schemas so they can't drift.
 * Definition files point at them with "$schema", which gives contributors
 * autocomplete and inline errors in VS Code and other editors.
 * Cross-field rules (unique keys, declared tools, dependencies) are only
 * checked by `npm run catalog:validate`.
 */
export const GENERATED_SCHEMAS = {
  "workflow.schema.json": { title: "100 Workflows: workflow definition", schema: ManifestSchema },
  "shared-inputs.schema.json": { title: "100 Workflows: shared inputs", schema: SharedInputsFileSchema },
  "tools.schema.json": { title: "100 Workflows: tool registry", schema: ToolsFileSchema },
} as const;

export function renderSchema(name: keyof typeof GENERATED_SCHEMAS): string {
  const { title, schema } = GENERATED_SCHEMAS[name];
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
  return JSON.stringify({ ...json, title }, null, 2) + "\n";
}
