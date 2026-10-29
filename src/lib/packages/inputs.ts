import { z } from "zod";
import type { InputField, Workflow } from "@/lib/catalog/schema";
import type { Requirements } from "./resolve";

/**
 * Package input values are stored under one key each:
 *   shared business context  →  "<input key>"              e.g. company_name
 *   workflow-specific input  →  "<workflow id>.<input key>" e.g. outbound-sequence.tone
 * so a shared answer is given once and read by every workflow that declares it.
 */
export function storageKey(workflowId: string | null, key: string): string {
  return workflowId ? `${workflowId}.${key}` : key;
}

export interface FormField {
  storageKey: string;
  field: InputField;
  required: boolean;
  /** Workflows that read this value. */
  usedBy: string[];
  /** Workflows that can't run without it. */
  requiredBy: string[];
  workflowId: string | null;
}

/** Every field the setup form shows, shared ones first. */
export function formFields(req: Requirements): FormField[] {
  return [
    ...req.shared.map((s) => ({
      storageKey: storageKey(null, s.field.key),
      field: s.field,
      required: s.required,
      usedBy: s.usedBy,
      requiredBy: s.requiredBy,
      workflowId: null,
    })),
    ...req.perWorkflow.flatMap((p) =>
      p.fields.map((f) => ({
        storageKey: storageKey(p.workflowId, f.key),
        field: f,
        required: f.required,
        usedBy: [p.workflowId],
        requiredBy: f.required ? [p.workflowId] : [],
        workflowId: p.workflowId,
      })),
    ),
  ];
}

const LIMITS = { text: 500, long_text: 20_000, url: 2_000 } as const;

/** Zod schema for one field's value. Optional fields accept "empty" (stored as absent). */
export function valueSchema(field: InputField): z.ZodType {
  switch (field.type) {
    case "text":
    case "long_text":
      return z.string().trim().min(1, "required").max(LIMITS[field.type], `keep it under ${LIMITS[field.type]} characters`);
    case "url":
      return z
        .string()
        .trim()
        .max(LIMITS.url)
        .refine((v) => /^https?:\/\/[^\s]+\.[^\s]+/i.test(v), "enter a full http(s) URL");
    case "number":
      return z.coerce.number({ message: "enter a number" }).refine(Number.isFinite, "enter a number");
    case "select":
      return z.enum((field.options ?? []) as [string, ...string[]], { message: `choose one of: ${(field.options ?? []).join(", ")}` });
    case "list":
      return z
        .array(z.string().trim().max(500, "keep each item under 500 characters"))
        .transform((items) => items.filter(Boolean))
        .pipe(z.array(z.string()).min(1, "add at least one item").max(50, "at most 50 items"));
  }
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.every((v) => typeof v !== "string" || v.trim() === ""));
}

export interface ValidationResult {
  /** Clean values to store. */
  set: Record<string, unknown>;
  /** Keys the user cleared. */
  cleared: string[];
  errors: Record<string, string>;
}

/**
 * Validates submitted values against the package's current fields. Unknown keys
 * are rejected rather than stored, so the form can't be used to write arbitrary data.
 * Missing required values are NOT errors here: a user may save a partial setup.
 */
export function validateValues(fields: FormField[], submitted: Record<string, unknown>): ValidationResult {
  const byKey = new Map(fields.map((f) => [f.storageKey, f]));
  const result: ValidationResult = { set: {}, cleared: [], errors: {} };
  for (const [key, value] of Object.entries(submitted)) {
    const f = byKey.get(key);
    if (!f) {
      result.errors[key] = "unknown field";
      continue;
    }
    if (isEmpty(value)) {
      result.cleared.push(key);
      continue;
    }
    const parsed = valueSchema(f.field).safeParse(value);
    if (parsed.success) result.set[key] = parsed.data;
    else result.errors[key] = parsed.error.issues[0]?.message ?? "invalid value";
  }
  return result;
}

export interface MissingInput {
  storageKey: string;
  label: string;
  workflowIds: string[];
}

/** Required fields without a stored value, limited to the given workflows when provided. */
export function missingRequired(fields: FormField[], values: Record<string, unknown>, onlyFor?: Set<string>): MissingInput[] {
  return fields
    .filter((f) => f.required && isEmpty(values[f.storageKey]))
    .map((f) => ({ storageKey: f.storageKey, label: f.field.label, workflowIds: onlyFor ? f.requiredBy.filter((id) => onlyFor.has(id)) : f.requiredBy }))
    .filter((m) => m.workflowIds.length > 0);
}

/** The values one workflow receives, keyed by its own input keys. */
export function inputsFor(workflow: Workflow, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of workflow.inputs) {
    const own = values[storageKey(workflow.id, field.key)];
    const shared = values[storageKey(null, field.key)];
    const v = own ?? shared;
    if (!isEmpty(v)) out[field.key] = v;
  }
  return out;
}
