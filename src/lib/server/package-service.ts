import "server-only";
import { z } from "zod";
import { loadCatalog } from "@/lib/catalog/load";
import type { Workflow } from "@/lib/catalog/schema";
import {
  PackageError,
  executionOrder,
  expandSelection,
  pinStatus,
  removeMember,
  summarizeRequirements,
  type Member,
  type PinStatus,
  type Requirements,
} from "@/lib/packages/resolve";
import type { DB } from "./db";
import {
  createPackage,
  definitionHash,
  getPackage,
  repinMember,
  setMembers,
  type PackageRecord,
  type PackageSummary,
  type PinnedMember,
} from "./db/packages";

export const CreatePackageSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  goal: z.string().trim().max(2000).optional(),
  conversationId: z.string().uuid().nullable().optional(),
  workflowIds: z.array(z.string().max(100)).min(1, "select at least one workflow").max(20),
});

export const UpdatePackageSchema = z
  .object({ name: z.string().trim().min(1).max(80).optional(), goal: z.string().trim().max(2000).optional() })
  .refine((p) => p.name !== undefined || p.goal !== undefined, { message: "nothing to update" });

export const AddWorkflowSchema = z.object({ workflowId: z.string().max(100) });

export interface PackageStep {
  order: number;
  member: PinnedMember;
  pin: PinStatus;
  /** Names of package members that must wait for this one. */
  unlocks: string[];
}

export interface PackageView {
  pkg: PackageSummary;
  steps: PackageStep[];
  requirements: Requirements;
  inputs: Record<string, unknown>;
  catalog: Workflow[];
}

export function buildView(record: PackageRecord, catalog: Workflow[]): PackageView {
  const latest = new Map(catalog.map((w) => [w.id, w]));
  const ordered = executionOrder(record.members) as PinnedMember[];
  return {
    pkg: record,
    steps: ordered.map((member, i) => ({
      order: i + 1,
      member,
      pin: pinStatus(member.hash, member.version, latest.get(member.workflow.id), definitionHash),
      unlocks: record.members
        .filter((m) => m.workflow.dependencies.some((d) => d.workflowId === member.workflow.id))
        .map((m) => m.workflow.name),
    })),
    requirements: summarizeRequirements(record.members, catalog),
    inputs: record.inputs,
    catalog,
  };
}

export async function loadPackageView(db: DB, id: string): Promise<PackageView | null> {
  const record = getPackage(db, id);
  if (!record) return null;
  return buildView(record, (await loadCatalog()).workflows);
}

function defaultName(workflows: Member[]): string {
  const selected = workflows.filter((m) => m.addedAs === "selected").map((m) => m.workflow.name);
  return selected.length === 1 ? `${selected[0]} package` : `${selected[0]} + ${selected.length - 1} more`;
}

export async function createFromSelection(db: DB, input: z.infer<typeof CreatePackageSchema>): Promise<string> {
  const { workflows } = await loadCatalog();
  const members = expandSelection(workflows, input.workflowIds);
  return createPackage(db, {
    name: input.name ?? defaultName(members),
    goal: input.goal ?? "",
    conversationId: input.conversationId ?? null,
    members,
  });
}

export async function addWorkflow(db: DB, packageId: string, workflowId: string): Promise<boolean> {
  const record = getPackage(db, packageId);
  if (!record) return false;
  const { workflows } = await loadCatalog();
  setMembers(db, packageId, expandSelection(workflows, [workflowId], record.members));
  return true;
}

export function removeWorkflow(db: DB, packageId: string, workflowId: string): boolean {
  const record = getPackage(db, packageId);
  if (!record) return false;
  setMembers(db, packageId, removeMember(record.members, workflowId));
  return true;
}

/**
 * Re-pins one workflow to the catalog's current definition, at the user's request.
 * New required dependencies of the updated definition are added too.
 */
export async function updateWorkflow(db: DB, packageId: string, workflowId: string): Promise<boolean> {
  const record = getPackage(db, packageId);
  if (!record) return false;
  const { workflows } = await loadCatalog();
  const latest = workflows.find((w) => w.id === workflowId);
  if (!latest) throw new PackageError(`"${workflowId}" is no longer in the catalog, so there is nothing to update to.`, "unknown_workflow");
  if (!record.members.some((m) => m.workflow.id === workflowId)) throw new PackageError(`"${workflowId}" is not in this package.`, "not_in_package");
  db.transaction(() => {
    repinMember(db, packageId, latest);
    const refreshed = getPackage(db, packageId)!;
    const missing = latest.dependencies.filter((d) => d.required && !refreshed.members.some((m) => m.workflow.id === d.workflowId)).map((d) => d.workflowId);
    if (missing.length) setMembers(db, packageId, expandSelection(workflows, missing, refreshed.members).map((m) => (missing.includes(m.workflow.id) ? { ...m, addedAs: "dependency" } : m)));
  })();
  return true;
}

export function packageErrorStatus(err: PackageError): number {
  return err.code === "required_by_other" ? 409 : err.code === "not_in_package" ? 404 : 400;
}
