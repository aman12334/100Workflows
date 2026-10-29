import type { InputField, Workflow } from "@/lib/catalog/schema";

/** Pure package logic shared by the API, the UI and tests. No I/O. */

export type AddedAs = "selected" | "dependency";

export interface Member {
  workflow: Workflow;
  addedAs: AddedAs;
}

export class PackageError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_workflow" | "required_by_other" | "empty" | "not_in_package",
  ) {
    super(message);
  }
}

/**
 * Adds every required dependency (transitively) to the selection. Workflows the
 * user picked stay "selected"; ones pulled in only to satisfy a requirement are
 * "dependency". Unknown ids are an error, never silently dropped.
 */
export function expandSelection(catalog: Workflow[], selectedIds: string[], existing: Member[] = []): Member[] {
  const byId = new Map(catalog.map((w) => [w.id, w]));
  const members = new Map(existing.map((m) => [m.workflow.id, m]));

  const unknown = selectedIds.filter((id) => !byId.has(id));
  if (unknown.length) throw new PackageError(`Not in the catalog: ${unknown.join(", ")}`, "unknown_workflow");

  const visit = (id: string, addedAs: AddedAs) => {
    const current = members.get(id);
    if (current) {
      if (addedAs === "selected" && current.addedAs === "dependency") members.set(id, { ...current, addedAs });
      return;
    }
    // Pre-existing members keep their pinned definition; only new ones come from the catalog.
    const wf = byId.get(id)!;
    members.set(id, { workflow: wf, addedAs });
    for (const dep of wf.dependencies) if (dep.required) visit(dep.workflowId, "dependency");
  };
  for (const id of selectedIds) visit(id, "selected");
  return [...members.values()];
}

/**
 * Removes a workflow. Fails if another member requires it. Afterwards drops
 * dependency-only members that nothing requires any more.
 */
export function removeMember(members: Member[], workflowId: string): Member[] {
  if (!members.some((m) => m.workflow.id === workflowId)) {
    throw new PackageError(`"${workflowId}" is not in this package.`, "not_in_package");
  }
  const dependents = members.filter((m) => m.workflow.id !== workflowId && m.workflow.dependencies.some((d) => d.required && d.workflowId === workflowId));
  if (dependents.length) {
    throw new PackageError(
      `Can't remove it: ${dependents.map((d) => d.workflow.name).join(", ")} ${dependents.length === 1 ? "needs" : "need"} it to run first. Remove ${dependents.length === 1 ? "that" : "those"} first.`,
      "required_by_other",
    );
  }
  let remaining = members.filter((m) => m.workflow.id !== workflowId);
  // Prune orphaned dependencies until stable (one may have been the only user of another).
  for (;;) {
    const needed = new Set(remaining.flatMap((m) => m.workflow.dependencies.filter((d) => d.required).map((d) => d.workflowId)));
    const next = remaining.filter((m) => m.addedAs === "selected" || needed.has(m.workflow.id));
    if (next.length === remaining.length) return next;
    remaining = next;
  }
}

/**
 * Execution order: every workflow comes after the package members it depends
 * on (required or optional). Ties keep a stable, readable order.
 */
export function executionOrder(members: Member[]): Member[] {
  const ids = new Set(members.map((m) => m.workflow.id));
  const sorted: Member[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(members.map((m) => [m.workflow.id, m]));

  const visit = (m: Member) => {
    const id = m.workflow.id;
    if (done.has(id) || visiting.has(id)) return; // cycles are rejected by catalog validation
    visiting.add(id);
    for (const dep of m.workflow.dependencies) if (ids.has(dep.workflowId)) visit(byId.get(dep.workflowId)!);
    visiting.delete(id);
    done.add(id);
    sorted.push(m);
  };
  const initial = [...members].sort((a, b) => a.workflow.name.localeCompare(b.workflow.name));
  for (const m of initial) visit(m);
  return sorted;
}

export interface SharedInput {
  field: InputField;
  required: boolean;
  usedBy: string[];
  /** The subset of usedBy that marks the field required. */
  requiredBy: string[];
}

export interface Requirements {
  /** Business context asked once and reused by every workflow listed in usedBy. */
  shared: SharedInput[];
  /** Inputs only one workflow needs. */
  perWorkflow: Array<{ workflowId: string; fields: InputField[] }>;
  tools: Array<{ id: string; required: boolean; usedBy: string[] }>;
  integrations: Array<{ id: string; name: string; required: boolean; usedBy: string[] }>;
  /** Optional dependencies in the catalog but not in the package. Adding them may improve results. */
  suggestions: Array<{ workflowId: string; reason: string; for: string }>;
  /** Same input key declared with incompatible types by different workflows. */
  conflicts: string[];
}

export function summarizeRequirements(members: Member[], catalog: Workflow[]): Requirements {
  const ordered = executionOrder(members);
  const inPackage = new Set(members.map((m) => m.workflow.id));
  const catalogIds = new Set(catalog.map((w) => w.id));

  // An input is shared when any workflow marks it shared, or when two or more workflows use the same key.
  const keyUse = new Map<string, Array<{ wf: Workflow; field: InputField }>>();
  for (const { workflow } of ordered) {
    for (const field of workflow.inputs) {
      const list = keyUse.get(field.key) ?? [];
      list.push({ wf: workflow, field });
      keyUse.set(field.key, list);
    }
  }

  const shared: SharedInput[] = [];
  const sharedKeys = new Set<string>();
  const conflicts: string[] = [];
  for (const [key, uses] of keyUse) {
    if (!uses.some((u) => u.field.shared) && uses.length < 2) continue;
    const types = new Set(uses.map((u) => u.field.type));
    if (types.size > 1) {
      conflicts.push(`"${key}" is declared as ${[...types].join(" and ")} by ${uses.map((u) => u.wf.name).join(", ")}.`);
      continue; // keep it per-workflow so each workflow still gets the type it expects
    }
    sharedKeys.add(key);
    shared.push({
      field: uses.find((u) => u.field.required)?.field ?? uses[0].field,
      required: uses.some((u) => u.field.required),
      usedBy: uses.map((u) => u.wf.id),
      requiredBy: uses.filter((u) => u.field.required).map((u) => u.wf.id),
    });
  }
  shared.sort((a, b) => Number(b.required) - Number(a.required) || b.usedBy.length - a.usedBy.length);

  const perWorkflow = ordered
    .map(({ workflow }) => ({ workflowId: workflow.id, fields: workflow.inputs.filter((f) => !sharedKeys.has(f.key)) }))
    .filter((p) => p.fields.length > 0);

  const tools = new Map<string, { id: string; required: boolean; usedBy: string[] }>();
  const integrations = new Map<string, { id: string; name: string; required: boolean; usedBy: string[] }>();
  for (const { workflow } of ordered) {
    for (const t of workflow.tools) {
      const e = tools.get(t.id) ?? { id: t.id, required: false, usedBy: [] };
      e.required ||= t.required;
      e.usedBy.push(workflow.id);
      tools.set(t.id, e);
    }
    for (const i of workflow.integrations) {
      const e = integrations.get(i.id) ?? { id: i.id, name: i.name, required: false, usedBy: [] };
      e.required ||= i.required;
      e.usedBy.push(workflow.id);
      integrations.set(i.id, e);
    }
  }

  const suggestions = ordered.flatMap(({ workflow }) =>
    workflow.dependencies
      .filter((d) => !d.required && !inPackage.has(d.workflowId) && catalogIds.has(d.workflowId))
      .map((d) => ({ workflowId: d.workflowId, reason: d.reason, for: workflow.id })),
  );

  return { shared, perWorkflow, tools: [...tools.values()], integrations: [...integrations.values()], suggestions, conflicts };
}

export type PinStatus =
  | { kind: "current" }
  | { kind: "update_available"; latestVersion: string }
  | { kind: "changed_same_version" }
  | { kind: "removed" };

/** Compares a pinned definition with what the catalog publishes now. Never changes anything. */
export function pinStatus(pinnedHash: string, pinnedVersion: string, latest: Workflow | undefined, hash: (w: Workflow) => string): PinStatus {
  if (!latest) return { kind: "removed" };
  if (hash(latest) === pinnedHash) return { kind: "current" };
  if (latest.version !== pinnedVersion) return { kind: "update_available", latestVersion: latest.version };
  return { kind: "changed_same_version" };
}
