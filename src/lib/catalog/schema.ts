import { z } from "zod";
import { OutputSchemaSpec } from "./output-schema";

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
    /** Schema v2, agent steps only: what this step asks the model to do. */
    prompt: text(4000).optional(),
    /**
     * Schema v2, agent steps only. "generate" writes the output from the inputs;
     * "revise" rewrites the previous step's output in the same schema. Agent steps
     * without a mode are review steps used by model-graded criteria.
     */
    mode: z.enum(["generate", "revise"]).optional(),
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

/** Schema v2: which deterministic rule checks a criterion (see src/lib/runtime/rules). */
export const RuleRefSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/, "must be a rule id, e.g. required_fields"),
    /** The check step to trace this rule under. Defaults to the first check step. */
    step: key.optional(),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Schema v2: how a model-graded criterion is reviewed. */
export const ReviewSpecSchema = z
  .object({
    /** An agent step without a mode, used to trace the review call. */
    step: key,
    rubric: text(400),
    /** Lowest 1-5 rating that passes. Defaults to 3. */
    passAt: z.number().int().min(1).max(5).optional(),
  })
  .strict();

export const EvaluationCriterionSchema = z
  .object({
    id: key,
    description: text(300),
    method: z.enum(["schema", "rule", "model"]),
    /** A critical failure fails the run regardless of the aggregate score. */
    critical: z.boolean().default(false),
    /** Schema v2, "rule" criteria: the deterministic rule that checks it. */
    rule: RuleRefSchema.optional(),
    /** Schema v2, "model" criteria: the review that grades it. */
    review: ReviewSpecSchema.optional(),
  })
  .strict();

/** Schema v2: how the generic executor runs this workflow. */
export const ExecutionSchema = z
  .object({
    engine: z.literal("generic"),
    /** Standing instructions for every model step of this workflow. */
    system: text(2000),
    /** Per model call. Defaults to 4000. */
    maxOutputTokens: z.number().int().min(256).max(16000).optional(),
    /** Defaults to "medium". */
    effort: z.enum(["low", "medium", "high"]).optional(),
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
    // Schema v2. All optional with no defaults, so a v1 definition parses to exactly
    // the same object as before and keeps its fingerprint (definitionHash).
    /** Absent means version 1. */
    schemaVersion: z.literal(2).optional(),
    execution: ExecutionSchema.optional(),
    outputSchema: OutputSchemaSpec.optional(),
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
    // Schema-v2 fields belong together and only in v2 definitions. Deeper checks that
    // need the rule registry live in validateGenericDefinition() (catalog.ts).
    if (wf.schemaVersion === 2) {
      if (!wf.execution) ctx.addIssue({ code: "custom", message: "schemaVersion 2 definitions need an \"execution\" section", path: ["execution"] });
      if (!wf.outputSchema) ctx.addIssue({ code: "custom", message: "schemaVersion 2 definitions need an \"outputSchema\"", path: ["outputSchema"] });
    } else {
      const v2only = (path: Array<string | number>, field: string) =>
        ctx.addIssue({ code: "custom", message: `"${field}" requires "schemaVersion": 2`, path });
      if (wf.execution) v2only(["execution"], "execution");
      if (wf.outputSchema) v2only(["outputSchema"], "outputSchema");
      wf.steps.forEach((st, i) => {
        if (st.prompt !== undefined) v2only(["steps", i, "prompt"], "prompt");
        if (st.mode !== undefined) v2only(["steps", i, "mode"], "mode");
      });
      wf.evaluation.criteria.forEach((c, i) => {
        if (c.rule) v2only(["evaluation", "criteria", i, "rule"], "rule");
        if (c.review) v2only(["evaluation", "criteria", i, "review"], "review");
      });
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
