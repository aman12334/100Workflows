import "server-only";
import { IntegrationError, fetchTransport, type HttpTransport } from "@/lib/integrations/core";
import { actionsLive, lookupAction } from "@/lib/integrations/registry";
import { payloadHash } from "@/lib/runtime/executors/integration";
import { addEvent, getAction, insertProposals, resolvedKeys, transition, type ActionRecord } from "./db/actions";
import type { DB } from "./db";
import { log } from "./log";

/**
 * The only path from a proposal to an external side effect:
 *
 *   pending_approval ──approve(hash)──▶ approved ──▶ executing ──▶ succeeded | failed | unconfirmed | dry_run
 *        │                                                       (provider-confirmed only)
 *        ├─ reject ──▶ rejected
 *        └─ revise(new payload) ──▶ superseded  (+ a new pending action with a new hash)
 *
 * - Approval quotes the payload hash shown to the person; a different hash is refused.
 * - Every transition is a conditional UPDATE, so an approval can be used once and two
 *   requests can't both execute the same action (replay and double-click protection).
 * - Execution sends the action's stable idempotency key to providers that support one.
 * - Without WORKFLOWS_ACTIONS=live nothing is sent: the action ends as dry_run.
 * - Success is recorded only when the provider confirmed it; an unknown outcome is
 *   "unconfirmed", never "succeeded".
 */

export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Env = Record<string, string | undefined>;
export const operatorName = (env: Env) => env.WORKFLOWS_OPERATOR?.trim().slice(0, 80) || "local user";

export async function approveAndExecute(
  db: DB,
  id: string,
  opts: { payloadHash: string; env?: Env; transport?: HttpTransport; signal?: AbortSignal; now?: () => Date },
): Promise<ActionRecord> {
  const env = opts.env ?? process.env;
  const actor = operatorName(env);
  const action = getAction(db, id);
  if (!action) throw new ActionError(404, "Action not found.");
  const def = lookupAction(`${action.action}@${action.actionVersion}`);
  if (!def) throw new ActionError(409, `"${action.action}@${action.actionVersion}" is no longer a registered action; it can't run.`);

  // Integrity: the stored payload must still hash to what was proposed, and to what the person saw.
  const recomputed = payloadHash(action.action, action.actionVersion, action.payload);
  if (recomputed !== action.payloadHash) {
    addEvent(db, id, "hash_mismatch", actor, "stored payload does not match its hash");
    throw new ActionError(409, "This action's stored payload was changed after it was proposed; it can't be approved.");
  }
  if (opts.payloadHash !== action.payloadHash) {
    addEvent(db, id, "hash_mismatch", actor, "approval quoted a different payload");
    throw new ActionError(409, "The payload you approved is not the current payload of this action. Reload and review it again.");
  }
  if (action.status !== "pending_approval") {
    addEvent(db, id, "replay_blocked", actor, `status was ${action.status}`);
    throw new ActionError(409, `This action is ${action.status.replace(/_/g, " ")}; an approval can be used only once.`);
  }
  if (Date.parse(action.expiresAt) < Date.now()) {
    if (transition(db, id, ["pending_approval"], "expired")) addEvent(db, id, "expired", "system");
    throw new ActionError(409, "This proposal has expired. Run the workflow again to get a fresh one.");
  }
  const parsed = def.input.safeParse(action.payload);
  if (!parsed.success) throw new ActionError(409, `The payload is no longer valid for ${action.action}: ${parsed.error.issues[0]?.message}`);

  const at = new Date().toISOString();
  if (!transition(db, id, ["pending_approval"], "approved", { approved_by: actor, approved_at: at })) {
    addEvent(db, id, "replay_blocked", actor, "approval raced with another request");
    throw new ActionError(409, "This action was already approved or changed.");
  }
  addEvent(db, id, "approved", actor, `payload ${action.payloadHash.slice(0, 12)}`);
  if (!transition(db, id, ["approved"], "executing")) throw new ActionError(409, "This action is already executing.");
  addEvent(db, id, "executing", "system", actionsLive(env) ? "live" : "dry run");

  if (!actionsLive(env)) {
    transition(db, id, ["executing"], "dry_run", { executed_at: new Date().toISOString(), result_json: JSON.stringify({ dry_run: true, would: action.summary }) });
    addEvent(db, id, "dry_run", "system", "Not sent: actions are in dry-run mode (set WORKFLOWS_ACTIONS=live to allow real actions).");
    return getAction(db, id)!;
  }

  try {
    const output = await def.execute(parsed.data, {
      env,
      transport: opts.transport ?? fetchTransport,
      signal: opts.signal ?? new AbortController().signal,
      idempotencyKey: (db.prepare("SELECT idempotency_key FROM action_requests WHERE id = ?").get(id) as { idempotency_key: string }).idempotency_key,
      now: opts.now ?? (() => new Date()),
      resolved: resolvedKeys(db, action.workflowRunId),
    });
    const checked = def.output.parse(output);
    const externalId = def.externalId?.(checked) ?? null;
    transition(db, id, ["executing"], "succeeded", { executed_at: new Date().toISOString(), external_id: externalId, result_json: JSON.stringify(checked) });
    addEvent(db, id, "succeeded", "system", externalId ? `provider id ${externalId}` : "provider confirmed");
    log.info("action.succeeded", { actionId: id, action: action.action, externalId });
  } catch (err) {
    const kind = err instanceof IntegrationError ? err.kind : "provider_error";
    const message = err instanceof Error ? err.message : String(err);
    const status = kind === "unconfirmed" ? "unconfirmed" : "failed";
    transition(db, id, ["executing"], status, { executed_at: new Date().toISOString(), error: message.slice(0, 500), error_kind: kind });
    addEvent(db, id, status, "system", `${kind}: ${message}`);
    log.warn("action.failed", { actionId: id, action: action.action, kind });
  }
  return getAction(db, id)!;
}

export function rejectAction(db: DB, id: string, env: Env = process.env, reason = ""): ActionRecord {
  const actor = operatorName(env);
  if (!getAction(db, id)) throw new ActionError(404, "Action not found.");
  if (!transition(db, id, ["pending_approval"], "rejected")) throw new ActionError(409, "Only actions awaiting approval can be rejected.");
  addEvent(db, id, "rejected", actor, reason || null);
  return getAction(db, id)!;
}

/** A person edits the payload: the old action is superseded and a new one, with a new hash, awaits approval. */
export function reviseAction(db: DB, id: string, input: unknown, env: Env = process.env): ActionRecord {
  const actor = operatorName(env);
  const action = getAction(db, id);
  if (!action) throw new ActionError(404, "Action not found.");
  const def = lookupAction(`${action.action}@${action.actionVersion}`);
  if (!def) throw new ActionError(409, "This action is no longer registered.");
  const parsed = def.input.safeParse(input);
  if (!parsed.success) throw new ActionError(400, `Invalid payload: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
  if (!transition(db, id, ["pending_approval"], "superseded")) throw new ActionError(409, "Only actions awaiting approval can be revised.");
  addEvent(db, id, "superseded", actor, "payload revised");
  const d = def.describe(parsed.data);
  const [newId] = insertProposals(
    db,
    action.workflowRunId,
    [{ key: action.proposalKey, action: action.action, version: action.actionVersion, provider: action.provider, side_effect: action.sideEffect, input: parsed.data, target: d.target, summary: d.summary, payload_hash: payloadHash(action.action, action.actionVersion, parsed.data) }],
    id,
  );
  return getAction(db, newId)!;
}
