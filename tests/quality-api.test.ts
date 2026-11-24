import { beforeAll, describe, expect, it } from "vitest";

// Route handlers use the app-wide database; point it at memory before they load.
process.env.WORKFLOWS_DB_PATH = ":memory:";

/** Quality dashboard API: numbers must equal what the evidence says; reviews are validated. Mocked only. */

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let list: () => Promise<Response>;
let detail: Handler;
let review: (req: Request) => Promise<Response>;
const post = (body: unknown) => new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  ({ GET: list } = (await import("@/app/api/quality/route")) as never);
  ({ GET: detail } = (await import("@/app/api/quality/[id]/route")) as never);
  ({ POST: review } = (await import("@/app/api/quality/reviews/route")) as never);
  const { getDb } = await import("@/lib/server/db");
  const { verifyAutomated } = await import("@/lib/server/quality/service");
  await verifyAutomated(getDb(), { ids: ["prd-writer"] });
}, 60_000);

describe("quality API", () => {
  it("lists every workflow with levels that match the scorecards and the release report", async () => {
    const body = (await (await list()).json()) as {
      workflows: Array<{ workflow: { id: string }; scorecard: { level: number; release: string; criteria: Array<{ id: string; status: string; evidence: { id: string; mode: string } | null }> } }>;
      release: { ok: boolean; checked: number; passing: string[] };
    };
    expect(body.workflows).toHaveLength(100);
    expect(body.release).toMatchObject({ ok: false, checked: 93, passing: [] });
    const prd = body.workflows.find((w) => w.workflow.id === "prd-writer")!;
    expect(prd.scorecard.level).toBe(1);
    const happy = prd.scorecard.criteria.find((c) => c.id === "happy_path")!;
    expect(happy).toMatchObject({ status: "passed", evidence: { mode: "mocked" } });
    // Untested workflows show nothing as passed except static checks.
    const other = body.workflows.find((w) => w.workflow.id === "okr-drafter")!;
    expect(other.scorecard.criteria.filter((c) => c.status === "passed" && c.evidence?.mode !== "static")).toEqual([]);
  }, 60_000);

  it("returns one workflow's evidence history with ids that match its scorecard", async () => {
    const res = await detail(new Request("http://localhost"), { params: Promise.resolve({ id: "prd-writer" }) });
    const body = (await res.json()) as { history: Array<{ id: string }>; scorecard: { criteria: Array<{ evidence: { id: string; mode: string } | null }> } };
    const ids = new Set(body.history.map((e) => e.id));
    for (const c of body.scorecard.criteria) if (c.evidence && c.evidence.mode !== "static") expect(ids.has(c.evidence.id)).toBe(true);
    expect((await detail(new Request("http://localhost"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
  }, 60_000);

  it("validates human reviews: known output, every rubric item scored, no accepting a critical issue", async () => {
    const { getDb } = await import("@/lib/server/db");
    const { storeOutput } = await import("@/lib/server/quality/store");
    const { loadGoldens } = await import("@/lib/server/quality/service");
    const rubric = loadGoldens().goldens["prd-writer"].rubric;
    const outputId = storeOutput(getDb(), { qualityRunId: null, workflowId: "prd-writer", workflowVersion: "0.1.0", scenario: "typical", status: "succeeded", output: {}, markdown: null, fingerprint: { definition: "d", code: "c", components: [] } });
    const all = Object.fromEntries(rubric.map((r) => [r.id, 4]));
    expect((await review(post({ outputId: "00000000-0000-4000-8000-000000000000", scores: all, verdict: "accept", severity: "none" }))).status).toBe(404);
    expect((await review(post({ outputId, scores: { [rubric[0].id]: 4 }, verdict: "accept", severity: "none" }))).status).toBe(400);
    expect((await review(post({ outputId, scores: all, verdict: "accept", severity: "critical" }))).status).toBe(400);
    expect((await review(post({ outputId, scores: { ...all, [rubric[0].id]: 9 }, verdict: "accept", severity: "none" }))).status).toBe(400);
    expect((await review(post({ outputId, scores: all, verdict: "reject", severity: "major", notes: "Invented a metric." }))).status).toBe(201);
  });
});
