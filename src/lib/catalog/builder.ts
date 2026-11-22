import { z } from "zod";
import { CATEGORY_LABELS, CategorySchema } from "./schema";

/**
 * The basic builder: a small form spec turned into a schema-v2, model-only
 * definition (one generate step, a schema check and optional rule checks).
 * The result goes through exactly the same validation as catalog workflows.
 * Builder workflows can't use tools, calculations or integrations: those need
 * reviewed code paths and stay in the catalog.
 */

const kebab = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "use lowercase-kebab-case").min(3).max(60);
const snake = z.string().regex(/^[a-z][a-z0-9_]*$/, "use lowercase_snake_case").max(40);

export const BuilderSpecSchema = z
  .object({
    id: kebab,
    name: z.string().trim().min(3).max(80),
    category: CategorySchema,
    summary: z.string().trim().min(20).max(160),
    whoFor: z.string().trim().min(5).max(200),
    limitations: z.string().trim().min(5).max(300),
    problems: z.array(z.string().trim().min(8).max(160)).min(3).max(6),
    tags: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).min(2).max(8),
    inputs: z
      .array(
        z
          .object({
            key: snake,
            label: z.string().trim().min(2).max(60),
            type: z.enum(["text", "long_text", "list", "select", "number", "url"]),
            required: z.boolean(),
            description: z.string().trim().min(5).max(200),
            options: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    instructions: z.string().trim().min(20).max(1500),
    task: z.string().trim().min(20).max(1500),
    sections: z
      .array(
        z
          .object({
            key: snake,
            title: z.string().trim().min(2).max(60),
            kind: z.enum(["text", "list"]),
            maxWords: z.number().int().min(10).max(2000).optional(),
            minItems: z.number().int().min(1).max(20).optional(),
            maxItems: z.number().int().min(1).max(50).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((s, ctx) => {
    const dup = (xs: string[]) => xs.find((x, i) => xs.indexOf(x) !== i);
    const d1 = dup(s.inputs.map((i) => i.key));
    if (d1) ctx.addIssue({ code: "custom", path: ["inputs"], message: `input key "${d1}" is used twice` });
    const d2 = dup(s.sections.map((x) => x.key));
    if (d2) ctx.addIssue({ code: "custom", path: ["sections"], message: `section key "${d2}" is used twice` });
    for (const [i, input] of s.inputs.entries()) if (input.type === "select" && !(input.options?.length ?? 0)) ctx.addIssue({ code: "custom", path: ["inputs", i, "options"], message: "a select input needs options" });
    for (const [i, sec] of s.sections.entries()) {
      if (sec.kind === "text" && (sec.minItems || sec.maxItems)) ctx.addIssue({ code: "custom", path: ["sections", i], message: "item counts apply to list sections only" });
      if (sec.minItems && sec.maxItems && sec.minItems > sec.maxItems) ctx.addIssue({ code: "custom", path: ["sections", i], message: "minItems is larger than maxItems" });
    }
  });
export type BuilderSpec = z.infer<typeof BuilderSpecSchema>;

export function definitionFromSpec(s: BuilderSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const sec of s.sections) properties[sec.key] = sec.kind === "list" ? { type: "array", title: sec.title, items: { type: "string" } } : { type: "string", title: sec.title };
  const criteria: Array<Record<string, unknown>> = [{ id: "schema_valid", description: "Output matches the schema.", method: "schema", critical: true }];
  for (const sec of s.sections) {
    if (sec.maxWords) criteria.push({ id: `${sec.key}_length`, description: `${sec.title} is ${sec.maxWords} words or fewer.`, method: "rule", critical: false, rule: { id: "max_words", params: { path: sec.kind === "list" ? `${sec.key}[]` : sec.key, max: sec.maxWords } } });
    if (sec.minItems || sec.maxItems) criteria.push({ id: `${sec.key}_count`, description: `${sec.title} has the expected number of items.`, method: "rule", critical: false, rule: { id: "count", params: { path: sec.key, ...(sec.minItems ? { min: sec.minItems } : {}), ...(sec.maxItems ? { max: sec.maxItems } : {}) } } });
  }
  return {
    schemaVersion: 2,
    id: s.id,
    version: "0.1.0",
    name: s.name,
    category: s.category,
    summary: s.summary,
    description: `${s.summary} Who it's for: ${s.whoFor} Limitations: ${s.limitations} Made with the builder.`,
    status: "available",
    problems: s.problems,
    tags: [...new Set([...s.tags, "custom"])].slice(0, 8),
    inputs: s.inputs.map((i) => ({ key: i.key, label: i.label, type: i.type, required: i.required, description: i.description, ...(i.type === "select" ? { options: i.options } : {}) })),
    outputs: [{ key: "result", label: s.name, description: s.summary, format: "markdown" }],
    execution: { engine: "generic", system: s.instructions, effort: "medium" },
    outputSchema: { type: "object", additionalProperties: false, required: s.sections.map((x) => x.key), properties },
    steps: [
      { id: "draft", name: "Draft", kind: "agent", mode: "generate", responsibility: "Writes the result from your inputs.", prompt: s.task, tools: [] },
      ...(criteria.length > 1 ? [{ id: "check", name: "Check", kind: "check", responsibility: "Checks the result's length and item counts.", tools: [] }] : []),
    ],
    tools: [],
    integrations: [],
    dependencies: [],
    evaluation: { criteria, threshold: 0.75 },
    limits: { maxRetries: 1, timeoutSeconds: 180, maxModelCalls: 2 },
  };
}

export const BUILDER_CATEGORIES = Object.entries(CATEGORY_LABELS);
