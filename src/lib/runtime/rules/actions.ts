import { z } from "zod";
import { lookupAction } from "@/lib/integrations/registry";
import { select } from "./path";
import type { RuleDefinition, RuleOutcome } from "./registry";

/**
 * Proposed external actions must be exactly what the registered action accepts,
 * and must pass its deterministic checks against data read earlier in the run
 * (the channel is one the bot is in, the contact doesn't already exist, the
 * slot is free...). Nothing is executed here; execution happens only after a
 * person approves the exact payload.
 */

const pass = (detail: string): RuleOutcome => ({ passed: true, score: 1, detail });

export const validActionPayloads: RuleDefinition<{ path: string; action: string; field?: string; allowedFrom?: string }> = {
  id: "valid_action_payloads",
  summary: "Every proposed action matches its registered action's input schema and passes that action's checks against data read in this run.",
  params: z
    .object({
      path: z.string().min(1),
      action: z.string().regex(/^[a-z_]+\.[a-z_]+@\d+$/, "must be an action reference such as slack.post_message@1"),
      /** Optional: this payload field must be one of the values read in this run at `allowedFrom` (an action id plus a path, e.g. "stripe.list_open_invoices:invoices[].customer_email"). */
      field: z.string().regex(/^[a-z_]+$/).optional(),
      allowedFrom: z.string().regex(/^[a-z_]+\.[a-z_]+:.+$/).optional(),
    })
    .strict()
    .refine((p) => (p.field === undefined) === (p.allowedFrom === undefined), "field and allowedFrom go together"),
  outputPaths: (p) => [{ param: "path", path: p.path, types: ["object"] }],
  staticCheck: (p) => (lookupAction(p.action) ? [] : [`"${p.action}" is not a registered action`]),
  run(p, ctx) {
    const action = lookupAction(p.action);
    if (!action) return { passed: false, score: 0, detail: `"${p.action}" is not a registered action.` };
    const items = select(ctx.output, p.path).values;
    let allowed: Set<string> | null = null;
    if (p.allowedFrom) {
      const [actionId, path] = p.allowedFrom.split(":");
      allowed = new Set(select(ctx.integrationData?.[actionId] ?? {}, path).values.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase()));
    }
    if (!items.length) return pass(`No ${action.title.toLowerCase()} actions proposed.`);
    const problems: string[] = [];
    items.forEach((item, i) => {
      const parsed = action.input.safeParse(item);
      if (!parsed.success) {
        problems.push(`#${i + 1}: ${parsed.error.issues.slice(0, 2).map((x) => `${x.path.join(".") || "input"} ${x.message}`).join("; ")}`);
        return;
      }
      for (const prob of action.validate?.(parsed.data, ctx.integrationData ?? {}, ctx.now ?? new Date()) ?? []) problems.push(`#${i + 1}: ${prob}`);
      if (allowed && p.field) {
        const v = String((parsed.data as Record<string, unknown>)[p.field] ?? "").toLowerCase();
        if (!allowed.has(v)) problems.push(`#${i + 1}: ${p.field} "${v}" is not in the data read in this run`);
      }
    });
    const bad = new Set(problems.map((x) => x.split(":")[0])).size;
    return problems.length
      ? { passed: false, score: (items.length - bad) / items.length, detail: `${problems.slice(0, 4).join("; ")}${problems.length > 4 ? ` and ${problems.length - 4} more` : ""}.` }
      : pass(`All ${items.length} proposed ${action.title.toLowerCase()} action(s) are valid.`);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ACTION_RULES: ReadonlyArray<RuleDefinition<any>> = [validActionPayloads];
