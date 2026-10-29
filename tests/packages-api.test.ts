import { beforeAll, describe, expect, it } from "vitest";

// Route handlers use the app-wide database; point it at memory before they load.
process.env.WORKFLOWS_DB_PATH = ":memory:";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let createPkg: (req: Request) => Promise<Response>;
let patchPkg: Handler;
let deletePkg: Handler;
let addWf: Handler;
let removeWf: Handler;

beforeAll(async () => {
  ({ POST: createPkg } = await import("@/app/api/packages/route"));
  ({ PATCH: patchPkg, DELETE: deletePkg } = (await import("@/app/api/packages/[id]/route")) as unknown as { PATCH: Handler; DELETE: Handler });
  ({ POST: addWf } = (await import("@/app/api/packages/[id]/workflows/route")) as unknown as { POST: Handler });
  ({ DELETE: removeWf } = (await import("@/app/api/packages/[id]/workflows/[workflowId]/route")) as unknown as { DELETE: Handler });
});

const json = (body: unknown) => new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body) });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function create(workflowIds: string[]) {
  const res = await createPkg(json({ workflowIds, goal: "first 100 customers" }));
  return { res, body: (await res.json()) as { id?: string; error?: { code: string; message: string } } };
}

describe("package API", () => {
  it("creates a package with dependencies resolved and a sensible default name", async () => {
    const { res, body } = await create(["outbound-sequence"]);
    expect(res.status).toBe(201);
    const { getDb } = await import("@/lib/server/db");
    const { getPackage } = await import("@/lib/server/db/packages");
    const pkg = getPackage(getDb(), body.id!)!;
    expect(pkg.name).toBe("Cold Outbound Sequence Writer package");
    expect(pkg.members.map((m) => m.workflow.id).sort()).toEqual(["icp-builder", "outbound-sequence"]);
  });

  it("rejects invented workflow ids and empty selections", async () => {
    expect((await create(["growth-hacker-9000"])).res.status).toBe(400);
    expect((await create([])).res.status).toBe(400);
    expect((await createPkg(new Request("http://localhost/api", { method: "POST", body: "{nope" }))).status).toBe(400);
  });

  it("adds, refuses unsafe removal, and deletes", async () => {
    const { body } = await create(["outbound-sequence"]);
    const id = body.id!;

    expect((await addWf(json({ workflowId: "market-research" }), ctx({ id }))).status).toBe(200);
    const blocked = await removeWf(new Request("http://localhost", { method: "DELETE" }), ctx({ id, workflowId: "icp-builder" }));
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { message: string } }).error.message).toMatch(/needs it/);

    expect((await removeWf(new Request("http://localhost", { method: "DELETE" }), ctx({ id, workflowId: "outbound-sequence" }))).status).toBe(200);
    expect((await patchPkg(new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }), ctx({ id }))).status).toBe(200);
    expect((await patchPkg(new Request("http://localhost", { method: "PATCH", body: "{}" }), ctx({ id }))).status).toBe(400);

    expect((await deletePkg(new Request("http://localhost", { method: "DELETE" }), ctx({ id }))).status).toBe(200);
    expect((await deletePkg(new Request("http://localhost", { method: "DELETE" }), ctx({ id }))).status).toBe(404);
  });
});
