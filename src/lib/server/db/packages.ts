import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { WorkflowSchema, type Workflow } from "@/lib/catalog/schema";
import type { AddedAs, Member } from "@/lib/packages/resolve";
import type { DB } from "./index";

export interface PackageSummary {
  id: string;
  name: string;
  goal: string;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PinnedMember extends Member {
  version: string;
  hash: string;
  addedAt: string;
}

export interface PackageRecord extends PackageSummary {
  members: PinnedMember[];
  inputs: Record<string, unknown>;
}

const now = () => new Date().toISOString();

/** Key order is fixed by the schema, so the hash only changes when the definition does. */
export function definitionHash(workflow: Workflow): string {
  return createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}

const SUMMARY_COLUMNS = "id, name, goal, conversation_id AS conversationId, created_at AS createdAt, updated_at AS updatedAt";

function insertMember(db: DB, packageId: string, workflow: Workflow, addedAs: AddedAs) {
  db.prepare(
    `INSERT INTO package_workflows (package_id, workflow_id, version, definition_json, definition_hash, added_as, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(packageId, workflow.id, workflow.version, JSON.stringify(workflow), definitionHash(workflow), addedAs, now());
}

function touch(db: DB, packageId: string) {
  db.prepare("UPDATE packages SET updated_at = ? WHERE id = ?").run(now(), packageId);
}

export function createPackage(db: DB, input: { name: string; goal: string; conversationId: string | null; members: Member[] }): string {
  const id = randomUUID();
  db.transaction(() => {
    db.prepare("INSERT INTO packages (id, name, goal, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      input.name,
      input.goal,
      input.conversationId,
      now(),
      now(),
    );
    for (const m of input.members) insertMember(db, id, m.workflow, m.addedAs);
  })();
  return id;
}

export function listPackages(db: DB): Array<PackageSummary & { workflowIds: string[] }> {
  const rows = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM packages ORDER BY updated_at DESC`).all() as PackageSummary[];
  const members = db.prepare("SELECT package_id, workflow_id FROM package_workflows ORDER BY added_at").all() as Array<{
    package_id: string;
    workflow_id: string;
  }>;
  return rows.map((p) => ({ ...p, workflowIds: members.filter((m) => m.package_id === p.id).map((m) => m.workflow_id) }));
}

export function getPackage(db: DB, id: string): PackageRecord | null {
  const pkg = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM packages WHERE id = ?`).get(id) as PackageSummary | undefined;
  if (!pkg) return null;
  const rows = db
    .prepare("SELECT version, definition_json, definition_hash, added_as, added_at FROM package_workflows WHERE package_id = ? ORDER BY added_at")
    .all(id) as Array<{ version: string; definition_json: string; definition_hash: string; added_as: AddedAs; added_at: string }>;
  const inputs = db.prepare("SELECT input_key, value_json FROM package_inputs WHERE package_id = ?").all(id) as Array<{
    input_key: string;
    value_json: string;
  }>;
  return {
    ...pkg,
    members: rows.map((r) => ({
      // Snapshots were validated when stored; re-validating guards against hand-edited databases.
      workflow: WorkflowSchema.parse(JSON.parse(r.definition_json)),
      addedAs: r.added_as,
      version: r.version,
      hash: r.definition_hash,
      addedAt: r.added_at,
    })),
    inputs: Object.fromEntries(inputs.map((i) => [i.input_key, JSON.parse(i.value_json)])),
  };
}

/**
 * Makes the package contain exactly `members`. Rows already present keep their
 * pinned definition (only their added_as may change); new rows are pinned now.
 */
export function setMembers(db: DB, packageId: string, members: Member[]) {
  db.transaction(() => {
    const existing = new Set(
      (db.prepare("SELECT workflow_id FROM package_workflows WHERE package_id = ?").all(packageId) as Array<{ workflow_id: string }>).map(
        (r) => r.workflow_id,
      ),
    );
    const wanted = new Set(members.map((m) => m.workflow.id));
    for (const id of existing) {
      if (!wanted.has(id)) db.prepare("DELETE FROM package_workflows WHERE package_id = ? AND workflow_id = ?").run(packageId, id);
    }
    for (const m of members) {
      if (existing.has(m.workflow.id)) {
        db.prepare("UPDATE package_workflows SET added_as = ? WHERE package_id = ? AND workflow_id = ?").run(m.addedAs, packageId, m.workflow.id);
      } else {
        insertMember(db, packageId, m.workflow, m.addedAs);
      }
    }
    touch(db, packageId);
  })();
}

/** Explicit, user-requested re-pin of one workflow to the catalog's current definition. */
export function repinMember(db: DB, packageId: string, workflow: Workflow): boolean {
  const result = db
    .prepare("UPDATE package_workflows SET version = ?, definition_json = ?, definition_hash = ? WHERE package_id = ? AND workflow_id = ?")
    .run(workflow.version, JSON.stringify(workflow), definitionHash(workflow), packageId, workflow.id);
  if (result.changes) touch(db, packageId);
  return result.changes > 0;
}

export function updatePackageMeta(db: DB, id: string, patch: { name?: string; goal?: string }): boolean {
  const pkg = db.prepare("SELECT name, goal FROM packages WHERE id = ?").get(id) as { name: string; goal: string } | undefined;
  if (!pkg) return false;
  db.prepare("UPDATE packages SET name = ?, goal = ?, updated_at = ? WHERE id = ?").run(patch.name ?? pkg.name, patch.goal ?? pkg.goal, now(), id);
  return true;
}

export function deletePackage(db: DB, id: string): boolean {
  return db.prepare("DELETE FROM packages WHERE id = ?").run(id).changes > 0;
}

export function packagesForConversation(db: DB, conversationId: string): Array<{ id: string; name: string }> {
  return db.prepare("SELECT id, name FROM packages WHERE conversation_id = ? ORDER BY created_at").all(conversationId) as Array<{ id: string; name: string }>;
}

/** Upserts validated input values and removes cleared ones, in one transaction. */
export function saveInputs(db: DB, packageId: string, set: Record<string, unknown>, cleared: string[]) {
  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO package_inputs (package_id, input_key, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (package_id, input_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    );
    for (const [key, value] of Object.entries(set)) upsert.run(packageId, key, JSON.stringify(value), now());
    const remove = db.prepare("DELETE FROM package_inputs WHERE package_id = ? AND input_key = ?");
    for (const key of cleared) remove.run(packageId, key);
    touch(db, packageId);
  })();
}
