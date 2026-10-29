import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog/load";
import { WorkflowSchema, type Workflow } from "@/lib/catalog/schema";
import { expandSelection } from "@/lib/packages/resolve";
import { openDatabase, type DB } from "@/lib/server/db";
import { appendMessage, createConversation, deleteConversation, getConversation, listConversations, titleFrom } from "@/lib/server/db/conversations";
import { migrate, readMigrations } from "@/lib/server/db/migrate";
import { createPackage, definitionHash, deletePackage, getPackage, listPackages, repinMember, setMembers } from "@/lib/server/db/packages";

let db: DB;
let catalog: Workflow[];

beforeEach(async () => {
  db = openDatabase(":memory:");
  migrate(db);
  catalog = (await loadCatalog()).workflows;
});

describe("migrations", () => {
  it("applies every migration once and is idempotent", () => {
    const fresh = openDatabase(":memory:");
    expect(migrate(fresh)).toEqual(readMigrations().map((m) => m.id));
    expect(migrate(fresh)).toEqual([]);
  });

  it("refuses to run when an applied migration was edited", () => {
    const fresh = openDatabase(":memory:");
    const migrations = readMigrations();
    migrate(fresh, migrations);
    const edited = migrations.map((m, i) => (i === 0 ? { ...m, sql: m.sql + "\n-- edit" } : m));
    expect(() => migrate(fresh, edited)).toThrow(/modified after it was applied/);
  });

  it("rolls back a failing migration completely", () => {
    const fresh = openDatabase(":memory:");
    expect(() => migrate(fresh, [{ id: "001_bad", sql: "CREATE TABLE ok (id TEXT); CREATE TABLE broken (" }])).toThrow();
    const tables = fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain("ok");
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 0 });
  });

  it("ships migrations in the expected folder", () => {
    expect(readMigrations(path.join(process.cwd(), "migrations")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("conversations", () => {
  it("stores messages in order with their reply metadata", () => {
    const c = createConversation(db, "I want my first 100 customers");
    appendMessage(db, c.id, "user", "I want my first 100 customers");
    appendMessage(db, c.id, "assistant", "Try these", {
      text: "Try these",
      recommendations: [],
      workflows: [],
      unknownWorkflowIds: [],
      searchedWorkflowIds: [],
      usage: { inputTokens: 1, outputTokens: 2, modelCalls: 1 },
      model: "m",
    });
    const stored = getConversation(db, c.id)!;
    expect(stored.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(stored.messages[1].reply?.usage.outputTokens).toBe(2);
    expect(listConversations(db)[0].id).toBe(c.id);
  });

  it("makes short, single-line titles", () => {
    expect(titleFrom("  hello\n\nworld  ")).toBe("hello world");
    expect(titleFrom("x".repeat(200)).length).toBeLessThanOrEqual(70);
  });

  it("deleting a conversation keeps packages but unlinks them", () => {
    const c = createConversation(db, "hi");
    const id = createPackage(db, { name: "P", goal: "", conversationId: c.id, members: expandSelection(catalog, ["market-research"]) });
    deleteConversation(db, c.id);
    expect(getPackage(db, id)?.conversationId).toBeNull();
  });
});

describe("packages", () => {
  it("persists selected workflows and their required dependencies with pinned snapshots", () => {
    const id = createPackage(db, { name: "Outbound", goal: "first customers", conversationId: null, members: expandSelection(catalog, ["outbound-sequence"]) });
    const pkg = getPackage(db, id)!;
    expect(pkg.members.map((m) => [m.workflow.id, m.addedAs]).sort()).toEqual([
      ["icp-builder", "dependency"],
      ["outbound-sequence", "selected"],
    ]);
    const outbound = pkg.members.find((m) => m.workflow.id === "outbound-sequence")!;
    expect(outbound.version).toBe(catalog.find((w) => w.id === "outbound-sequence")!.version);
    expect(outbound.hash).toBe(definitionHash(catalog.find((w) => w.id === "outbound-sequence")!));
    expect(listPackages(db)[0].workflowIds).toHaveLength(2);
  });

  it("keeps the pinned definition when the catalog changes, until explicitly re-pinned", () => {
    const id = createPackage(db, { name: "P", goal: "", conversationId: null, members: expandSelection(catalog, ["market-research"]) });
    const original = catalog.find((w) => w.id === "market-research")!;
    const changed = WorkflowSchema.parse({ ...original, version: "0.2.0", summary: "A newer summary for the market research agent." });

    // Re-applying membership from a newer catalog must not touch the pinned row.
    setMembers(db, id, expandSelection([changed, ...catalog.filter((w) => w.id !== changed.id)], ["market-research"]));
    expect(getPackage(db, id)!.members[0].workflow.summary).toBe(original.summary);

    repinMember(db, id, changed);
    const after = getPackage(db, id)!.members[0];
    expect(after.version).toBe("0.2.0");
    expect(after.workflow.summary).toBe(changed.summary);
  });

  it("cascades deletes to members and inputs", () => {
    const id = createPackage(db, { name: "P", goal: "", conversationId: null, members: expandSelection(catalog, ["icp-builder"]) });
    db.prepare("INSERT INTO package_inputs (package_id, input_key, value_json, updated_at) VALUES (?, 'company_name', '\"Acme\"', 'now')").run(id);
    expect(getPackage(db, id)!.inputs).toEqual({ company_name: "Acme" });
    expect(deletePackage(db, id)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM package_workflows").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM package_inputs").get()).toEqual({ n: 0 });
  });

  it("rejects a hand-edited snapshot that no longer validates", () => {
    const id = createPackage(db, { name: "P", goal: "", conversationId: null, members: expandSelection(catalog, ["icp-builder"]) });
    db.prepare("UPDATE package_workflows SET definition_json = '{\"id\":\"icp-builder\"}'").run();
    expect(() => getPackage(db, id)).toThrow();
  });
});
