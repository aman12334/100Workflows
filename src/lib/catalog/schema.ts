import { z } from "zod";

/**
 * Workflow definitions are plain JSON data. They never contain executable code;
 * the runtime (milestone 3) decides what each step is allowed to do.
 */

export const CATEGORIES = [
  "gtm",
  "marketing",
  "sales",
  "finance",
  "product",
  "user-research",
  "operations",
] as const;

export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const CATEGORY_LABELS: Record<Category, string> = {
  gtm: "Go-to-market",
  marketing: "Marketing",
  sales: "Sales",
  finance: "Finance",
  product: "Product",
  "user-research": "User research",
  operations: "Operations",
};

const id = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase kebab-case, e.g. market-research");

const key = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "must be snake_case, e.g. company_name");

const text = (max: number) => z.string().trim().min(1).max(max);

export const InputFieldSchema = z
  .object({
    key,
    label: text(80),
    type: z.enum(["text", "long_text", "url", "number", "select", "list"]),
    required: z.boolean(),
    description: text(300),
    /** Shared fields are business context asked once per package and reused across workflows. */
    shared: z.boolean().default(false),
    options: z.array(text(80)).min(1).optional(),
    example: z.string().max(300).optional(),
  })
  .strict()
  .refine((f) => f.type !== "select" || (f.options?.length ?? 0) > 0, {
    message: "select inputs need at least one option",
    path: ["options"],
  });

export const OutputSchema = z
  .object({
    key,
    label: text(80),
    description: text(300),
    format: z.enum(["markdown", "json", "table", "list"]),
  })
  .strict();

export const StepSchema = z
  .object({
    id: key,
    name: text(80),
    /** "agent" uses a model; "check" is deterministic code owned by the app, not the workflow. */
    kind: z.enum(["agent", "check"]),
    responsibility: text(400),
    tools: z.array(id).default([]),
  })
  .strict();

export const ToolRequirementSchema = z
  .object({
    id,
    purpose: text(300),
    required: z.boolean(),
  })
  .strict();

export const IntegrationSchema = z
  .object({
    id,
    name: text(80),
    purpose: text(300),
    required: z.boolean(),
  })
  .strict();

export const DependencySchema = z
  .object({
    workflowId: id,
    /** Required dependencies must run first; optional ones enrich the result when present. */
    required: z.boolean(),
    reason: text(300),
  })
  .strict();

export const EvaluationCriterionSchema = z
  .object({
    id: key,
    description: text(300),
    method: z.enum(["schema", "rule", "model"]),
    /** A critical failure fails the run regardless of the aggregate score. */
    critical: z.boolean().default(false),
  })
  .strict();

const workflowShape = {
    id,
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver, e.g. 0.1.0"),
    name: text(80),
    category: CategorySchema,
    summary: text(200),
    description: text(1500),
    /** "available" means the runtime can execute it today. Everything else is a definition only. */
    status: z.enum(["available", "planned"]),
    problems: z.array(text(200)).min(1).max(12),
    tags: z.array(id).max(15).default([]),
    inputs: z.array(InputFieldSchema).min(1).max(30),
    outputs: z.array(OutputSchema).min(1).max(15),
    steps: z.array(StepSchema).min(1).max(12),
    tools: z.array(ToolRequirementSchema).default([]),
    integrations: z.array(IntegrationSchema).default([]),
    dependencies: z.array(DependencySchema).default([]),
    evaluation: z
      .object({
        criteria: z.array(EvaluationCriterionSchema).min(1).max(20),
        /** Minimum aggregate quality score (0–1) for an output to be accepted. */
        threshold: z.number().min(0).max(1),
      })
      .strict(),
    limits: z
      .object({
        maxRetries: z.number().int().min(0).max(3),
        timeoutSeconds: z.number().int().min(10).max(1800),
        maxModelCalls: z.number().int().min(1).max(50),
      })
      .strict(),
};

/** A fully expanded definition: what packages pin, the runtime executes and the UI shows. */
export const WorkflowSchema = z
  .object(workflowShape)
  .strict()
  .superRefine((wf, ctx) => {
    const unique = (values: string[], path: string) => {
      const seen = new Set<string>();
      for (const v of values) {
        if (seen.has(v)) ctx.addIssue({ code: "custom", message: `duplicate ${path} "${v}"`, path: [path] });
        seen.add(v);
      }
    };
    unique(wf.inputs.map((i) => i.key), "inputs");
    unique(wf.outputs.map((o) => o.key), "outputs");
    unique(wf.steps.map((s) => s.id), "steps");
    unique(wf.dependencies.map((d) => d.workflowId), "dependencies");

    if (wf.dependencies.some((d) => d.workflowId === wf.id)) {
      ctx.addIssue({ code: "custom", message: "a workflow cannot depend on itself", path: ["dependencies"] });
    }
    const declaredTools = new Set(wf.tools.map((t) => t.id));
    for (const step of wf.steps) {
      for (const tool of step.tools) {
        if (!declaredTools.has(tool)) {
          ctx.addIssue({
            code: "custom",
            message: `step "${step.id}" uses tool "${tool}" which is not declared in "tools"`,
            path: ["steps"],
          });
        }
      }
    }
  });

export type Workflow = z.infer<typeof WorkflowSchema>;
export type InputField = z.infer<typeof InputFieldSchema>;

/**
 * A reference to an entry in catalog/shared-inputs.json. Shared business
 * context is defined once there, so every workflow asks for it the same way and
 * a package asks for it only once.
 */
export const InputRefSchema = z
  .object({
    use: key,
    required: z.boolean(),
  })
  .strict();

/** One entry of catalog/shared-inputs.json. Whether it is required is up to each workflow. */
export const SharedInputDefSchema = z
  .object({
    key,
    label: text(80),
    type: z.enum(["text", "long_text", "url", "number", "select", "list"]),
    description: text(300),
    options: z.array(text(80)).min(1).optional(),
    example: z.string().max(300).optional(),
  })
  .strict();
export type SharedInputDef = z.infer<typeof SharedInputDefSchema>;

export const SharedInputsFileSchema = z.object({ $schema: z.string().optional(), inputs: z.array(SharedInputDefSchema) }).strict();

/** One entry of catalog/tools.json: a capability the runtime may provide to workflow steps. */
export const ToolDefSchema = z
  .object({
    id,
    name: text(80),
    description: text(300),
    /** Whether the runtime can provide this tool today, and how it is turned on. */
    available: z.boolean(),
    setup: z.string().max(300).optional(),
  })
  .strict();
export type ToolDef = z.infer<typeof ToolDefSchema>;

export const ToolsFileSchema = z.object({ $schema: z.string().optional(), tools: z.array(ToolDefSchema) }).strict();

/**
 * The on-disk shape of a definition file: like WorkflowSchema, but inputs may
 * reference shared inputs and `$schema` is allowed for editor validation.
 * Used to generate catalog/workflow.schema.json.
 */
export const ManifestSchema = z
  .object({
    $schema: z.string().optional(),
    ...workflowShape,
    inputs: z.array(z.union([InputRefSchema, InputFieldSchema])).min(1).max(30),
  })
  .strict();
