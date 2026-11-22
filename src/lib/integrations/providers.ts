import { createHash } from "node:crypto";
import { z } from "zod";
import { IntegrationError, parseJsonBody, request, requireEnv, type ActionContext, type ActionDefinition, type ProviderDefinition } from "./core";

/**
 * Provider adapters. Every endpoint, field and header used here was checked
 * against the provider's official documentation (see each provider's `docs`);
 * where a detail could not be confirmed it is noted next to the code and the
 * adapter is conservative (e.g. treats an unknown outcome as unconfirmed).
 */

const email = z.string().trim().email("must be an email address").max(254);
const text = (max: number) => z.string().trim().min(1).max(max);
const key = z.string().regex(/^[a-z0-9_-]{1,40}$/, "key must be short, lowercase, e.g. task_1");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ======================================================================== Resend
export const resend: ProviderDefinition = {
  id: "resend",
  name: "Resend (email)",
  auth: { kind: "api_key", env: ["RESEND_API_KEY", "RESEND_FROM"] },
  scopes: ["An API key with sending access (\"Sending access\" permission is enough)."],
  setup: "Create an API key at resend.com, verify a sending domain, and set RESEND_API_KEY and RESEND_FROM (e.g. \"Acme <hello@acme.com>\").",
  docs: ["https://resend.com/docs/api-reference/emails/send-email", "https://resend.com/docs/api-reference/rate-limit"],
  minIntervalMs: 110, // default limit is 10 requests/second per team
};

const SendEmail = z.object({ key: key.optional(), to: email, subject: text(200), text: text(20_000) }).strict();
export const resendSendEmail: ActionDefinition<z.infer<typeof SendEmail>, { id: string }> = {
  id: "resend.send_email",
  version: "1",
  provider: "resend",
  title: "Send an email",
  sideEffect: "external_side_effect",
  input: SendEmail,
  output: z.object({ id: z.string() }).strict(),
  idempotency: "provider_header",
  timeoutMs: 20_000,
  describe: (i) => ({ target: i.to, summary: `Email "${i.subject}" to ${i.to}` }),
  async execute(i, ctx) {
    const env = requireEnv(resend, ctx.env);
    const res = await request(
      resend,
      {
        method: "POST",
        url: "https://api.resend.com/emails",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": ctx.idempotencyKey.slice(0, 256) },
        body: JSON.stringify({ from: env.RESEND_FROM, to: [i.to], subject: i.subject, text: i.text }),
      },
      ctx,
      { safeToRetry: true, timeoutMs: this.timeoutMs }, // Idempotency-Key makes retries safe for 24 hours
    );
    return { id: String(parseJsonBody<{ id: string }>(res).id) };
  },
  externalId: (o) => o.id,
};

// ======================================================================= HubSpot
export const hubspot: ProviderDefinition = {
  id: "hubspot",
  name: "HubSpot CRM",
  auth: { kind: "bearer_token", env: ["HUBSPOT_ACCESS_TOKEN"] },
  scopes: ["crm.objects.contacts.read", "crm.objects.contacts.write", "crm.objects.companies.read", "crm.objects.companies.write", "crm.objects.deals.read", "crm.objects.deals.write", "crm.objects.tickets.read", "crm.objects.tickets.write"],
  setup: "Create a private app in HubSpot (Settings > Integrations > Private apps) with only the scopes listed, and set HUBSPOT_ACCESS_TOKEN.",
  docs: ["https://developers.hubspot.com/docs/api/crm/search", "https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/create-contact.md", "https://developers.hubspot.com/docs/api-reference/latest/crm/pipelines/stages/list-stages.md"],
  minIntervalMs: 220, // CRM search endpoints allow 5 requests/second per account
};
const HS = "https://api.hubapi.com/crm/objects/2026-09";
const hsHeaders = (ctx: ActionContext) => ({ authorization: `Bearer ${requireEnv(hubspot, ctx.env).HUBSPOT_ACCESS_TOKEN}`, "content-type": "application/json" });
type HsObject = { id: string; properties: Record<string, string | null> };
async function hsSearch(object: string, filter: { propertyName: string; operator: string; value?: string; values?: string[] }, properties: string[], ctx: ActionContext, limit = 100) {
  const res = await request(hubspot, { method: "POST", url: `${HS}/${object}/search`, headers: hsHeaders(ctx), body: JSON.stringify({ filterGroups: [{ filters: [filter] }], properties, limit }) }, ctx, { safeToRetry: true, timeoutMs: 20_000 });
  return parseJsonBody<{ results: HsObject[] }>(res).results ?? [];
}

const ContactProps = z
  .object({ email, firstname: z.string().max(100).optional(), lastname: z.string().max(100).optional(), company: z.string().max(200).optional(), jobtitle: z.string().max(200).optional(), phone: z.string().max(50).optional() })
  .strict();
const contactOut = z.object({ results: z.array(z.object({ id: z.string(), email: z.string().nullable(), firstname: z.string().nullable(), lastname: z.string().nullable(), company: z.string().nullable() }).strict()) }).strict();
export const hubspotSearchContacts: ActionDefinition<{ emails: string[] }, z.infer<typeof contactOut>> = {
  id: "hubspot.search_contacts",
  version: "1",
  provider: "hubspot",
  title: "Find contacts by email",
  sideEffect: "read_only",
  input: z.object({ emails: z.array(email).min(1).max(100) }).strict(),
  output: contactOut,
  idempotency: "not_applicable",
  timeoutMs: 20_000,
  describe: (i) => ({ target: `${i.emails.length} email address(es)`, summary: "Look up existing contacts" }),
  async execute(i, ctx) {
    const found = await hsSearch("contacts", { propertyName: "email", operator: "IN", values: i.emails.map((e) => e.toLowerCase()) }, ["email", "firstname", "lastname", "company"], ctx);
    return { results: found.map((r) => ({ id: r.id, email: r.properties.email ?? null, firstname: r.properties.firstname ?? null, lastname: r.properties.lastname ?? null, company: r.properties.company ?? null })) };
  },
};

const existingEmails = (data: Record<string, unknown>) =>
  new Set(((data["hubspot.search_contacts"] as z.infer<typeof contactOut> | undefined)?.results ?? []).map((r) => (r.email ?? "").toLowerCase()));
export const hubspotCreateContact: ActionDefinition<z.infer<typeof ContactProps>, { id: string }> = {
  id: "hubspot.create_contact",
  version: "1",
  provider: "hubspot",
  title: "Create a contact",
  sideEffect: "reversible_write",
  input: ContactProps,
  output: z.object({ id: z.string() }).strict(),
  idempotency: "precheck",
  timeoutMs: 20_000,
  describe: (i) => ({ target: i.email, summary: `Create contact ${[i.firstname, i.lastname].filter(Boolean).join(" ") || i.email}` }),
  validate: (i, data) => (existingEmails(data).has(i.email.toLowerCase()) ? [`${i.email} already exists in HubSpot; update it instead of creating a duplicate`] : []),
  async execute(i, ctx) {
    const dup = await hsSearch("contacts", { propertyName: "email", operator: "EQ", value: i.email.toLowerCase() }, ["email"], ctx, 1);
    if (dup.length) throw new IntegrationError("duplicate", `a contact with ${i.email} already exists (id ${dup[0].id}); nothing was created`);
    const res = await request(hubspot, { method: "POST", url: `${HS}/contacts`, headers: hsHeaders(ctx), body: JSON.stringify({ properties: i, associations: [] }) }, ctx, { safeToRetry: false, timeoutMs: this.timeoutMs });
    return { id: String(parseJsonBody<HsObject>(res).id) };
  },
  externalId: (o) => o.id,
};

const UpdateContact = z.object({ contact_id: z.string().regex(/^\d+$/, "must be a HubSpot record id"), properties: ContactProps.omit({ email: true }).partial().refine((p) => Object.keys(p).length > 0, "change at least one property") }).strict();
export const hubspotUpdateContact: ActionDefinition<z.infer<typeof UpdateContact>, { id: string }> = {
  id: "hubspot.update_contact",
  version: "1",
  provider: "hubspot",
  title: "Update a contact",
  sideEffect: "reversible_write",
  input: UpdateContact,
  output: z.object({ id: z.string() }).strict(),
  idempotency: "not_applicable", // setting the same properties twice has the same result
  timeoutMs: 20_000,
  describe: (i) => ({ target: `contact ${i.contact_id}`, summary: `Update ${Object.keys(i.properties).join(", ")}` }),
  validate: (i, data) => {
    const known = ((data["hubspot.search_contacts"] as z.infer<typeof contactOut> | undefined)?.results ?? []).map((r) => r.id);
    return known.includes(i.contact_id) ? [] : [`contact ${i.contact_id} was not found in the lookup for this run`];
  },
  async execute(i, ctx) {
    const res = await request(hubspot, { method: "PATCH", url: `${HS}/contacts/${i.contact_id}`, headers: hsHeaders(ctx), body: JSON.stringify({ properties: i.properties }) }, ctx, { safeToRetry: true, timeoutMs: this.timeoutMs });
    return { id: String(parseJsonBody<HsObject>(res).id) };
  },
  externalId: (o) => o.id,
};

const CreateCompany = z.object({ name: text(200), domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "must be a domain like acme.com") }).strict();
export const hubspotCreateCompany: ActionDefinition<z.infer<typeof CreateCompany>, { id: string }> = {
  id: "hubspot.create_company",
  version: "1",
  provider: "hubspot",
  title: "Create a company",
  sideEffect: "reversible_write",
  input: CreateCompany,
  output: z.object({ id: z.string() }).strict(),
  idempotency: "precheck",
  timeoutMs: 20_000,
  describe: (i) => ({ target: i.domain, summary: `Create company ${i.name}` }),
  async execute(i, ctx) {
    // Uses the generic CRM search endpoint for companies (same request shape as contacts search).
    const dup = await hsSearch("companies", { propertyName: "domain", operator: "EQ", value: i.domain }, ["domain"], ctx, 1);
    if (dup.length) throw new IntegrationError("duplicate", `a company with domain ${i.domain} already exists (id ${dup[0].id}); nothing was created`);
    const res = await request(hubspot, { method: "POST", url: `${HS}/companies`, headers: hsHeaders(ctx), body: JSON.stringify({ properties: i, associations: [] }) }, ctx, { safeToRetry: false, timeoutMs: this.timeoutMs });
    return { id: String(parseJsonBody<HsObject>(res).id) };
  },
  externalId: (o) => o.id,
};

const dealOut = z.object({ deals: z.array(z.object({ id: z.string(), dealname: z.string().nullable(), dealstage: z.string().nullable(), amount: z.string().nullable(), pipeline: z.string().nullable() }).strict()) }).strict();
async function getDeal(id: string, ctx: ActionContext) {
  const res = await request(hubspot, { method: "GET", url: `${HS}/0-3/${encodeURIComponent(id)}?properties=dealname,dealstage,amount,pipeline`, headers: hsHeaders(ctx) }, ctx, { safeToRetry: true, timeoutMs: 20_000 });
  const d = parseJsonBody<HsObject>(res);
  return { id: String(d.id), dealname: d.properties.dealname ?? null, dealstage: d.properties.dealstage ?? null, amount: d.properties.amount ?? null, pipeline: d.properties.pipeline ?? null };
}
export const hubspotGetDeals: ActionDefinition<{ deal_ids: string[] }, z.infer<typeof dealOut>> = {
  id: "hubspot.get_deals",
  version: "1",
  provider: "hubspot",
  title: "Read deals",
  sideEffect: "read_only",
  input: z.object({ deal_ids: z.array(z.string().regex(/^\d+$/, "deal ids are numbers")).min(1).max(20) }).strict(),
  output: dealOut,
  idempotency: "not_applicable",
  timeoutMs: 20_000,
  describe: (i) => ({ target: `${i.deal_ids.length} deal(s)`, summary: "Read deal stage and amount" }),
  async execute(i, ctx) {
    const deals = [];
    for (const id of i.deal_ids) deals.push(await getDeal(id, ctx));
    return { deals };
  },
};

const stagesOut = z.object({ stages: z.array(z.object({ id: z.string(), label: z.string(), is_closed: z.boolean() }).strict()) }).strict();
async function listStages(pipelineId: string, ctx: ActionContext) {
  const res = await request(hubspot, { method: "GET", url: `https://api.hubapi.com/crm/pipelines/2026-09/0-3/${encodeURIComponent(pipelineId)}/stages`, headers: hsHeaders(ctx) }, ctx, { safeToRetry: true, timeoutMs: 20_000 });
  const r = parseJsonBody<{ results: Array<{ id: string; label: string; metadata?: Record<string, string> }> }>(res);
  return (r.results ?? []).map((s) => ({ id: String(s.id), label: String(s.label), is_closed: s.metadata?.isClosed === "true" }));
}
export const hubspotListDealStages: ActionDefinition<{ pipeline_id: string }, z.infer<typeof stagesOut>> = {
  id: "hubspot.list_deal_stages",
  version: "1",
  provider: "hubspot",
  title: "List deal stages",
  sideEffect: "read_only",
  input: z.object({ pipeline_id: z.string().trim().min(1).max(64) }).strict(),
  output: stagesOut,
  idempotency: "not_applicable",
  timeoutMs: 20_000,
  describe: (i) => ({ target: `pipeline ${i.pipeline_id}`, summary: "List the pipeline's stages" }),
  execute: async (i, ctx) => ({ stages: await listStages(i.pipeline_id, ctx) }),
};

const UpdateDeal = z
  .object({ deal_id: z.string().regex(/^\d+$/), dealstage: z.string().trim().min(1).max(64).optional(), amount: z.number().finite().min(0).max(1e12).optional() })
  .strict()
  .refine((d) => d.dealstage !== undefined || d.amount !== undefined, "change the stage, the amount or both");
/** Closed deals can't be moved by this workflow; reopening needs a person in HubSpot. */
export function dealTransitionProblems(current: { dealstage: string | null; amount: string | null }, next: { dealstage?: string; amount?: number }, stages: Array<{ id: string; is_closed: boolean }>): string[] {
  const p: string[] = [];
  if (next.dealstage !== undefined && !stages.some((s) => s.id === next.dealstage)) p.push(`stage "${next.dealstage}" is not in the deal's pipeline`);
  const from = stages.find((s) => s.id === current.dealstage);
  if (next.dealstage !== undefined && from?.is_closed && next.dealstage !== current.dealstage) p.push(`the deal is in closed stage "${from.id}"; it can't be moved by a workflow`);
  const sameStage = next.dealstage === undefined || next.dealstage === current.dealstage;
  const sameAmount = next.amount === undefined || Number(current.amount) === next.amount;
  if (sameStage && sameAmount) p.push("nothing would change (already at this stage and amount)");
  return p;
}
export const hubspotUpdateDeal: ActionDefinition<z.infer<typeof UpdateDeal>, { id: string }> = {
  id: "hubspot.update_deal",
  version: "1",
  provider: "hubspot",
  title: "Update a deal",
  sideEffect: "reversible_write",
  input: UpdateDeal,
  output: z.object({ id: z.string() }).strict(),
  idempotency: "precheck",
  timeoutMs: 20_000,
  describe: (i) => ({ target: `deal ${i.deal_id}`, summary: [i.dealstage ? `stage → ${i.dealstage}` : "", i.amount !== undefined ? `amount → ${i.amount}` : ""].filter(Boolean).join(", ") }),
  validate(i, data) {
    const deal = (data["hubspot.get_deals"] as z.infer<typeof dealOut> | undefined)?.deals.find((d) => d.id === i.deal_id);
    if (!deal) return [`deal ${i.deal_id} was not read in this run`];
    return dealTransitionProblems(deal, i, (data["hubspot.list_deal_stages"] as z.infer<typeof stagesOut> | undefined)?.stages ?? []);
  },
  async execute(i, ctx) {
    const current = await getDeal(i.deal_id, ctx); // re-check at execution: the deal may have changed since the plan
    const problems = dealTransitionProblems(current, i, current.pipeline ? await listStages(current.pipeline, ctx) : []);
    if (problems.length) throw new IntegrationError(problems[0].startsWith("nothing would change") ? "duplicate" : "validation", problems.join("; "));
    const properties: Record<string, string> = {};
    if (i.dealstage !== undefined) properties.dealstage = i.dealstage;
    if (i.amount !== undefined) properties.amount = String(i.amount);
    const res = await request(hubspot, { method: "PATCH", url: `${HS}/0-3/${i.deal_id}`, headers: hsHeaders(ctx), body: JSON.stringify({ properties }) }, ctx, { safeToRetry: true, timeoutMs: this.timeoutMs });
    return { id: String(parseJsonBody<HsObject>(res).id) };
  },
  externalId: (o) => o.id,
};

const ticketsOut = z.object({ tickets: z.array(z.object({ id: z.string(), subject: z.string().nullable(), content: z.string().nullable(), stage: z.string().nullable(), priority: z.string().nullable() }).strict()) }).strict();
export const hubspotSearchTickets: ActionDefinition<{ stage_ids: string[]; limit: number }, z.infer<typeof ticketsOut>> = {
  id: "hubspot.search_tickets",
  version: "1",
  provider: "hubspot",
  title: "Find tickets by stage",
  sideEffect: "read_only",
  input: z.object({ stage_ids: z.array(z.string().trim().min(1).max(64)).min(1).max(10), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  output: ticketsOut,
  idempotency: "not_applicable",
  timeoutMs: 20_000,
  describe: (i) => ({ target: `stages ${i.stage_ids.join(", ")}`, summary: "Read open tickets" }),
  async execute(i, ctx) {
    const found = await hsSearch("tickets", { propertyName: "hs_pipeline_stage", operator: "IN", values: i.stage_ids }, ["subject", "content", "hs_pipeline_stage", "hs_ticket_priority"], ctx, i.limit);
    return { tickets: found.map((t) => ({ id: t.id, subject: t.properties.subject ?? null, content: (t.properties.content ?? null)?.slice(0, 4000) ?? null, stage: t.properties.hs_pipeline_stage ?? null, priority: t.properties.hs_ticket_priority ?? null })) };
  },
};
const UpdateTicket = z.object({ ticket_id: z.string().regex(/^\d+$/), stage_id: z.string().trim().min(1).max(64) }).strict();
export const hubspotUpdateTicketStage: ActionDefinition<z.infer<typeof UpdateTicket>, { id: string }> = {
  id: "hubspot.update_ticket_stage",
  version: "1",
  provider: "hubspot",
  title: "Move a ticket to a stage",
  sideEffect: "reversible_write",
  input: UpdateTicket,
  output: z.object({ id: z.string() }).strict(),
  idempotency: "not_applicable",
  timeoutMs: 20_000,
  describe: (i) => ({ target: `ticket ${i.ticket_id}`, summary: `Move to stage ${i.stage_id}` }),
  validate(i, data) {
    const t = (data["hubspot.search_tickets"] as z.infer<typeof ticketsOut> | undefined)?.tickets.find((x) => x.id === i.ticket_id);
    if (!t) return [`ticket ${i.ticket_id} was not read in this run`];
    return t.stage === i.stage_id ? ["the ticket is already in that stage"] : [];
  },
  async execute(i, ctx) {
    const res = await request(hubspot, { method: "PATCH", url: `${HS}/tickets/${i.ticket_id}`, headers: hsHeaders(ctx), body: JSON.stringify({ properties: { hs_pipeline_stage: i.stage_id } }) }, ctx, { safeToRetry: true, timeoutMs: this.timeoutMs });
    return { id: String(parseJsonBody<HsObject>(res).id) };
  },
  externalId: (o) => o.id,
};

// ========================================================================= Slack
export const slack: ProviderDefinition = {
  id: "slack",
  name: "Slack",
  auth: { kind: "bearer_token", env: ["SLACK_BOT_TOKEN"] },
  scopes: ["chat:write", "channels:read", "groups:read"],
  setup: "Create a Slack app with a bot user, add only these bot scopes, install it to your workspace, invite the bot to the channels it may post in, and set SLACK_BOT_TOKEN (xoxb-...).",
  docs: ["https://docs.slack.dev/reference/methods/chat.postMessage", "https://docs.slack.dev/reference/methods/conversations.list"],
  minIntervalMs: 1100, // about 1 message per second per channel
};
const slackErrors: Record<string, ConstructorParameters<typeof IntegrationError>[0]> = {
  invalid_auth: "auth_invalid", not_authed: "auth_invalid", token_revoked: "auth_expired", account_inactive: "auth_invalid",
  missing_scope: "permission_denied", not_in_channel: "permission_denied", restricted_action: "permission_denied", is_archived: "permission_denied",
  channel_not_found: "not_found", ratelimited: "rate_limited", rate_limited: "rate_limited", no_text: "validation", msg_blocks_too_long: "validation",
};
function slackBody<T>(res: { body: string }): T {
  const j = parseJsonBody<{ ok: boolean; error?: string } & T>(res as never);
  if (!j.ok) throw new IntegrationError(slackErrors[j.error ?? ""] ?? "provider_error", `Slack: ${j.error ?? "unknown error"}`);
  return j;
}
const channelsOut = z.object({ channels: z.array(z.object({ id: z.string(), name: z.string(), is_member: z.boolean(), is_private: z.boolean() }).strict()) }).strict();
export const slackListChannels: ActionDefinition<Record<string, never>, z.infer<typeof channelsOut>> = {
  id: "slack.list_channels",
  version: "1",
  provider: "slack",
  title: "List channels",
  sideEffect: "read_only",
  input: z.object({}).strict(),
  output: channelsOut,
  idempotency: "not_applicable",
  timeoutMs: 20_000,
  describe: () => ({ target: "workspace", summary: "List channels the bot can see" }),
  async execute(_i, ctx) {
    const token = requireEnv(slack, ctx.env).SLACK_BOT_TOKEN;
    const res = await request(slack, { method: "GET", url: "https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200", headers: { authorization: `Bearer ${token}` } }, ctx, { safeToRetry: true, timeoutMs: this.timeoutMs });
    const j = slackBody<{ channels: Array<{ id: string; name: string; is_member?: boolean; is_private?: boolean }> }>(res);
    return { channels: (j.channels ?? []).map((c) => ({ id: c.id, name: c.name, is_member: Boolean(c.is_member), is_private: Boolean(c.is_private) })) };
  },
};
const PostMessage = z.object({ channel_id: z.string().regex(/^[CG][A-Z0-9]{2,20}$/, "must be a Slack channel id like C0123ABC"), text: text(4000) }).strict();
export const slackPostMessage: ActionDefinition<z.infer<typeof PostMessage>, { channel: string; ts: string }> = {
  id: "slack.post_message",
  version: "1",
  provider: "slack",
  title: "Post a message",
  sideEffect: "external_side_effect",
  input: PostMessage,
  output: z.object({ channel: z.string(), ts: z.string() }).strict(),
  idempotency: "ledger", // Slack has no idempotency key; the local ledger allows one execution per approval
  timeoutMs: 20_000,
  describe: (i) => ({ target: `channel ${i.channel_id}`, summary: `Post: "${i.text.slice(0, 60)}${i.text.length > 60 ? "…" : ""}"` }),
  validate(i, data) {
    const c = (data["slack.list_channels"] as z.infer<typeof channelsOut> | undefined)?.channels.find((x) => x.id === i.channel_id);
    if (!c) return [`channel ${i.channel_id} is not visible to the bot`];
    return c.is_member ? [] : [`the bot is not a member of #${c.name}; invite it first`];
  },
  async execute(i, ctx) {
    const token = requireEnv(slack, ctx.env).SLACK_BOT_TOKEN;
    const res = await request(slack, { method: "POST", url: "https://slack.com/api/chat.postMessage", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ channel: i.channel_id, text: i.text }) }, ctx, { safeToRetry: false, timeoutMs: this.timeoutMs });
    const j = slackBody<{ channel: string; ts: string }>(res);
    return { channel: String(j.channel), ts: String(j.ts) };
  },
  externalId: (o) => `${o.channel}/${o.ts}`,
};

// =============================================================== Google Calendar
export const google: ProviderDefinition = {
  id: "google_calendar",
  name: "Google Calendar",
  auth: { kind: "oauth_refresh_token", env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"], optionalEnv: ["GOOGLE_CALENDAR_ID"] },
  scopes: ["https://www.googleapis.com/auth/calendar.freebusy", "https://www.googleapis.com/auth/calendar.events"],
  setup: "Create an OAuth client (Desktop app) in Google Cloud, enable the Calendar API, obtain a refresh token for the two scopes, and set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN (optionally GOOGLE_CALENDAR_ID; default primary).",
  docs: ["https://developers.google.com/calendar/api/v3/reference/freebusy/query", "https://developers.google.com/calendar/api/v3/reference/events/insert", "https://developers.google.com/identity/protocols/oauth2/web-server"],
  minIntervalMs: 100,
};
let googleToken: { token: string; expires: number; for: string } | null = null;
async function googleAccessToken(ctx: ActionContext): Promise<string> {
  const env = requireEnv(google, ctx.env);
  const id = sha(`${env.GOOGLE_CLIENT_ID}:${env.GOOGLE_REFRESH_TOKEN}`);
  if (googleToken && googleToken.for === id && googleToken.expires > Date.now() + 60_000) return googleToken.token;
  const res = await request(
    google,
    { method: "POST", url: "https://oauth2.googleapis.com/token", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: env.GOOGLE_REFRESH_TOKEN, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }).toString() },
    ctx,
    { safeToRetry: true, timeoutMs: 15_000 },
  ).catch((err: unknown) => {
    if (err instanceof IntegrationError && err.kind === "validation") throw new IntegrationError("auth_expired", "Google refused the refresh token (it may have expired or been revoked); obtain a new one");
    throw err;
  });
  const j = parseJsonBody<{ access_token: string; expires_in: number }>(res);
  googleToken = { token: j.access_token, expires: Date.now() + Number(j.expires_in) * 1000, for: id };
  return j.access_token;
}
const calendarId = (env: Record<string, string | undefined>) => env.GOOGLE_CALENDAR_ID?.trim() || "primary";
const iso = z.string().datetime({ offset: true, message: "must be an ISO date-time with offset, e.g. 2026-11-20T15:00:00Z" });
const busyOut = z.object({ calendars: z.array(z.object({ id: z.string(), busy: z.array(z.object({ start: z.string(), end: z.string() }).strict()), error: z.string().nullable() }).strict()) }).strict();
async function freeBusy(ids: string[], timeMin: string, timeMax: string, ctx: ActionContext) {
  const token = await googleAccessToken(ctx);
  const res = await request(google, { method: "POST", url: "https://www.googleapis.com/calendar/v3/freeBusy", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ timeMin, timeMax, items: ids.map((id) => ({ id })) }) }, ctx, { safeToRetry: true, timeoutMs: 20_000 });
  const j = parseJsonBody<{ calendars: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason: string }> }> }>(res);
  return Object.entries(j.calendars ?? {}).map(([id, c]) => ({ id, busy: c.busy ?? [], error: c.errors?.[0]?.reason ?? null }));
}
export const googleFreeBusy: ActionDefinition<{ calendars: string[]; time_min: string; time_max: string }, z.infer<typeof busyOut>> = {
  id: "google_calendar.free_busy",
  version: "1",
  provider: "google_calendar",
  title: "Check availability",
  sideEffect: "read_only",
  input: z.object({ calendars: z.array(z.string().trim().min(3).max(254)).min(1).max(20), time_min: iso, time_max: iso }).strict(),
  output: busyOut,
  idempotency: "not_applicable",
  timeoutMs: 20_000,
  describe: (i) => ({ target: `${i.calendars.length} calendar(s)`, summary: `Busy times between ${i.time_min} and ${i.time_max}` }),
  execute: async (i, ctx) => ({ calendars: await freeBusy(i.calendars, i.time_min, i.time_max, ctx) }),
};
const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;
const CreateEvent = z
  .object({ summary: text(200), description: z.string().max(4000).optional(), start: iso, end: iso, attendees: z.array(email).max(50).default([]), notify_attendees: z.boolean().default(false) })
  .strict()
  .refine((e) => Date.parse(e.end) > Date.parse(e.start), "end must be after start");
export const googleCreateEvent: ActionDefinition<z.infer<typeof CreateEvent>, { id: string; html_link: string | null }> = {
  id: "google_calendar.create_event",
  version: "1",
  provider: "google_calendar",
  title: "Create a calendar event",
  sideEffect: "external_side_effect",
  input: CreateEvent,
  output: z.object({ id: z.string(), html_link: z.string().nullable() }).strict(),
  idempotency: "client_id", // a deterministic event id derived from the approval; Google allows client-supplied ids
  timeoutMs: 20_000,
  describe: (i) => ({ target: i.attendees.join(", ") || "your calendar", summary: `"${i.summary}" ${i.start} → ${i.end}${i.notify_attendees ? " (invitations sent)" : " (no invitations)"}` }),
  validate(i, data, now) {
    const p: string[] = [];
    if (Date.parse(i.start) <= now.getTime()) p.push("the meeting starts in the past");
    const cals = (data["google_calendar.free_busy"] as z.infer<typeof busyOut> | undefined)?.calendars ?? [];
    for (const c of cals) for (const b of c.busy) if (overlaps(Date.parse(i.start), Date.parse(i.end), Date.parse(b.start), Date.parse(b.end))) p.push(`${c.id} is busy ${b.start}–${b.end}`);
    return p;
  },
  async execute(i, ctx) {
    const cal = calendarId(ctx.env);
    const busy = await freeBusy([cal], i.start, i.end, ctx); // re-check the organiser's calendar right before creating
    if (busy.some((c) => c.busy.length)) throw new IntegrationError("conflict", "the time is no longer free on your calendar; nothing was created");
    const token = await googleAccessToken(ctx);
    const eventId = sha(ctx.idempotencyKey).slice(0, 32); // base32hex-compatible: 0-9 and a-f only
    const res = await request(
      google,
      {
        method: "POST",
        url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events?sendUpdates=${i.notify_attendees ? "all" : "none"}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: eventId, summary: i.summary, description: i.description, start: { dateTime: i.start }, end: { dateTime: i.end }, attendees: i.attendees.map((e) => ({ email: e })) }),
      },
      ctx,
      { safeToRetry: true, timeoutMs: this.timeoutMs }, // the fixed event id prevents a second event on retry
    ).catch((err: unknown) => {
      if (err instanceof IntegrationError && err.kind === "conflict") throw new IntegrationError("duplicate", "an event with this approval's id already exists; it was not created twice");
      throw err;
    });
    const j = parseJsonBody<{ id: string; htmlLink?: string }>(res);
    return { id: String(j.id), html_link: j.htmlLink ?? null };
  },
  externalId: (o) => o.id,
};

// ======================================================================== Linear
export const linear: ProviderDefinition = {
  id: "linear",
  name: "Linear",
  auth: { kind: "api_key", env: ["LINEAR_API_KEY", "LINEAR_TEAM_ID"] },
  scopes: ["A personal API key of a member of the team (Linear API keys carry that member's access)."],
  setup: "Create a personal API key in Linear (Settings > Security & access > API), and set LINEAR_API_KEY and LINEAR_TEAM_ID (the team that new issues belong to).",
  docs: ["https://linear.app/developers/graphql", "https://linear.app/developers/rate-limiting", "https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql"],
  minIntervalMs: 200,
};
async function linearQuery<T>(query: string, variables: Record<string, unknown>, ctx: ActionContext, safeToRetry: boolean): Promise<T> {
  const env = requireEnv(linear, ctx.env);
  const res = await request(linear, { method: "POST", url: "https://api.linear.app/graphql", headers: { authorization: env.LINEAR_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) }, ctx, { safeToRetry, timeoutMs: 20_000 });
  const j = parseJsonBody<{ data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> }>(res);
  if (j.errors?.length) {
    const e = j.errors[0];
    throw new IntegrationError(e.extensions?.code === "RATELIMITED" ? "rate_limited" : /auth/i.test(e.extensions?.code ?? "") ? "auth_invalid" : "validation", `Linear: ${e.message.slice(0, 200)}`);
  }
  if (!j.data) throw new IntegrationError("provider_error", "Linear returned no data");
  return j.data;
}
const CreateIssue = z
  .object({ key, title: text(250), description: z.string().max(10_000).optional(), due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due date must be YYYY-MM-DD").optional(), priority: z.number().int().min(0).max(4).optional() })
  .strict();
export const linearCreateIssue: ActionDefinition<z.infer<typeof CreateIssue>, { id: string; identifier: string | null; url: string | null }> = {
  id: "linear.create_issue",
  version: "1",
  provider: "linear",
  title: "Create an issue",
  sideEffect: "reversible_write",
  input: CreateIssue,
  output: z.object({ id: z.string(), identifier: z.string().nullable(), url: z.string().nullable() }).strict(),
  idempotency: "precheck",
  timeoutMs: 20_000,
  describe: (i) => ({ target: "Linear team", summary: `Issue "${i.title}"${i.due_date ? ` due ${i.due_date}` : ""}` }),
  async execute(i, ctx) {
    const teamId = requireEnv(linear, ctx.env).LINEAR_TEAM_ID;
    const existing = await linearQuery<{ team: { issues: { nodes: Array<{ id: string; url: string }> } } }>(
      "query($teamId: String!, $title: String!) { team(id: $teamId) { issues(filter: { title: { eq: $title } }) { nodes { id url } } } }",
      { teamId, title: i.title },
      ctx,
      true,
    );
    if (existing.team?.issues?.nodes?.length) throw new IntegrationError("duplicate", `an issue titled "${i.title}" already exists (${existing.team.issues.nodes[0].url}); nothing was created`);
    const data = await linearQuery<{ issueCreate: { success: boolean; issue: { id: string; identifier?: string; url?: string } } }>(
      "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
      { input: { teamId, title: i.title, description: i.description, dueDate: i.due_date, priority: i.priority } },
      ctx,
      false,
    );
    if (!data.issueCreate?.success) throw new IntegrationError("provider_error", "Linear did not confirm the issue was created");
    return { id: data.issueCreate.issue.id, identifier: data.issueCreate.issue.identifier ?? null, url: data.issueCreate.issue.url ?? null };
  },
  externalId: (o) => o.identifier ?? o.id,
};
const CreateRelation = z.object({ blocker_key: key, blocked_key: key }).strict().refine((r) => r.blocker_key !== r.blocked_key, "an issue can't block itself");
export const linearCreateBlocker: ActionDefinition<z.infer<typeof CreateRelation>, { success: boolean }> = {
  id: "linear.create_blocker",
  version: "1",
  provider: "linear",
  title: "Mark one issue as blocking another",
  sideEffect: "reversible_write",
  input: CreateRelation,
  output: z.object({ success: z.boolean() }).strict(),
  idempotency: "ledger",
  timeoutMs: 20_000,
  describe: (i) => ({ target: `${i.blocker_key} → ${i.blocked_key}`, summary: `${i.blocker_key} blocks ${i.blocked_key}` }),
  async execute(i, ctx) {
    const issueId = ctx.resolved[i.blocker_key];
    const relatedIssueId = ctx.resolved[i.blocked_key];
    if (!issueId || !relatedIssueId) throw new IntegrationError("validation", `both issues must be created first (${!issueId ? i.blocker_key : i.blocked_key} is not created yet)`);
    // issueRelationCreate input fields (issueId, relatedIssueId, type "blocks") per Linear's published GraphQL schema.
    const data = await linearQuery<{ issueRelationCreate: { success: boolean } }>(
      "mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }",
      { input: { issueId, relatedIssueId, type: "blocks" } },
      ctx,
      false,
    );
    if (!data.issueRelationCreate?.success) throw new IntegrationError("provider_error", "Linear did not confirm the relation");
    return { success: true };
  },
};

// ======================================================================== Stripe
export const stripe: ProviderDefinition = {
  id: "stripe",
  name: "Stripe (invoices, read-only)",
  auth: { kind: "api_key", env: ["STRIPE_API_KEY"] },
  scopes: ["A restricted key (rk_...) with Invoices: Read and nothing else."],
  setup: "Create a restricted API key in Stripe with Invoices set to Read only, and set STRIPE_API_KEY. Reminders are sent by email (Resend), not by Stripe.",
  docs: ["https://docs.stripe.com/api/invoices/list", "https://docs.stripe.com/api/invoices/object", "https://docs.stripe.com/api/authentication"],
  minIntervalMs: 50,
};
const invoicesOut = z
  .object({
    invoices: z.array(
      z
        .object({
          id: z.string(),
          number: z.string().nullable(),
          customer_name: z.string().nullable(),
          customer_email: z.string().nullable(),
          currency: z.string(),
          amount_remaining_minor: z.number().int(),
          amount_remaining: z.string(),
          due_date: z.string().nullable(),
          days_overdue: z.number().int().nullable(),
          hosted_invoice_url: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
/** Formats an amount in the smallest currency unit using the currency's own decimal places (JPY has none). */
export function formatMinor(minor: number, currency: string): string {
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return fmt.format(minor / 10 ** digits);
}
export const stripeListOpenInvoices: ActionDefinition<{ overdue_only: boolean }, z.infer<typeof invoicesOut>> = {
  id: "stripe.list_open_invoices",
  version: "1",
  provider: "stripe",
  title: "List open invoices",
  sideEffect: "read_only",
  input: z.object({ overdue_only: z.boolean().default(true) }).strict(),
  output: invoicesOut,
  idempotency: "not_applicable",
  timeoutMs: 20_000,
  describe: (i) => ({ target: "Stripe account", summary: i.overdue_only ? "Read overdue open invoices" : "Read open invoices" }),
  async execute(i, ctx) {
    const keyValue = requireEnv(stripe, ctx.env).STRIPE_API_KEY;
    // A full secret key can change and refund things; this integration only ever needs to read invoices.
    if (/^sk_/.test(keyValue)) throw new IntegrationError("not_configured", "STRIPE_API_KEY is a full secret key (sk_...). Use a restricted key (rk_...) with Invoices: Read only.");
    const res = await request(stripe, { method: "GET", url: "https://api.stripe.com/v1/invoices?status=open&limit=100", headers: { authorization: `Bearer ${keyValue}` } }, ctx, { safeToRetry: true, timeoutMs: this.timeoutMs });
    const j = parseJsonBody<{ data: Array<Record<string, unknown>> }>(res);
    const now = ctx.now().getTime();
    const invoices = (j.data ?? []).map((inv) => {
      const due = typeof inv.due_date === "number" ? inv.due_date * 1000 : null; // Stripe timestamps are seconds since the epoch
      const minor = Number(inv.amount_remaining ?? 0);
      const currency = String(inv.currency ?? "usd");
      return {
        id: String(inv.id),
        number: (inv.number as string | null) ?? null,
        customer_name: (inv.customer_name as string | null) ?? null,
        customer_email: (inv.customer_email as string | null) ?? null,
        currency,
        amount_remaining_minor: minor,
        amount_remaining: formatMinor(minor, currency),
        due_date: due ? new Date(due).toISOString().slice(0, 10) : null,
        days_overdue: due && now > due ? Math.floor((now - due) / 86_400_000) : due ? 0 : null,
        hosted_invoice_url: (inv.hosted_invoice_url as string | null) ?? null,
      };
    });
    return { invoices: i.overdue_only ? invoices.filter((x) => (x.days_overdue ?? 0) > 0) : invoices };
  },
};

// ====================================================================== Mastodon
export const mastodon: ProviderDefinition = {
  id: "mastodon",
  name: "Mastodon",
  auth: { kind: "bearer_token", env: ["MASTODON_INSTANCE_URL", "MASTODON_ACCESS_TOKEN"] },
  scopes: ["write:statuses", "read:accounts"],
  setup: "In your Mastodon account (Preferences > Development) create an application with only write:statuses and read:accounts, and set MASTODON_INSTANCE_URL (https://your.instance) and MASTODON_ACCESS_TOKEN.",
  docs: ["https://docs.joinmastodon.org/methods/statuses/", "https://docs.joinmastodon.org/methods/instance/", "https://docs.joinmastodon.org/api/rate-limits/"],
  minIntervalMs: 1000, // 300 calls per 5 minutes per account
};
function mastodonBase(ctx: ActionContext) {
  const env = requireEnv(mastodon, ctx.env);
  let url: URL;
  try {
    url = new URL(env.MASTODON_INSTANCE_URL);
  } catch {
    throw new IntegrationError("not_configured", "MASTODON_INSTANCE_URL must be a URL like https://mastodon.social");
  }
  if (url.protocol !== "https:") throw new IntegrationError("not_configured", "MASTODON_INSTANCE_URL must use https");
  return { base: url.origin, token: env.MASTODON_ACCESS_TOKEN };
}
const limitsOut = z.object({ max_characters: z.number().int() }).strict();
export const mastodonInstanceLimits: ActionDefinition<Record<string, never>, z.infer<typeof limitsOut>> = {
  id: "mastodon.instance_limits",
  version: "1",
  provider: "mastodon",
  title: "Read the server's post limits",
  sideEffect: "read_only",
  input: z.object({}).strict(),
  output: limitsOut,
  idempotency: "not_applicable",
  timeoutMs: 15_000,
  describe: () => ({ target: "your Mastodon server", summary: "Read the post length limit" }),
  async execute(_i, ctx) {
    const { base } = mastodonBase(ctx);
    const res = await request(mastodon, { method: "GET", url: `${base}/api/v2/instance`, headers: {} }, ctx, { safeToRetry: true, timeoutMs: this.timeoutMs });
    const j = parseJsonBody<{ configuration?: { statuses?: { max_characters?: number } } }>(res);
    return { max_characters: Number(j.configuration?.statuses?.max_characters ?? 500) };
  },
};
const PostStatus = z
  .object({ status: text(10_000), visibility: z.enum(["public", "unlisted", "private"]).default("public"), scheduled_at: iso.optional(), language: z.string().regex(/^[a-z]{2}$/).optional() })
  .strict();
export const MASTODON_MIN_SCHEDULE_MS = 5 * 60_000;
export const mastodonPostStatus: ActionDefinition<z.infer<typeof PostStatus>, { id: string; url: string | null; scheduled_at: string | null }> = {
  id: "mastodon.post_status",
  version: "1",
  provider: "mastodon",
  title: "Publish or schedule a post",
  sideEffect: "external_side_effect",
  input: PostStatus,
  output: z.object({ id: z.string(), url: z.string().nullable(), scheduled_at: z.string().nullable() }).strict(),
  idempotency: "provider_header", // Mastodon stores Idempotency-Key for up to 1 hour
  timeoutMs: 20_000,
  describe: (i) => ({ target: `${i.visibility} post`, summary: `${i.scheduled_at ? `Schedule for ${i.scheduled_at}` : "Publish now"}: "${i.status.slice(0, 60)}${i.status.length > 60 ? "…" : ""}"` }),
  validate(i, data, now) {
    const p: string[] = [];
    const max = (data["mastodon.instance_limits"] as z.infer<typeof limitsOut> | undefined)?.max_characters;
    if (max && Array.from(i.status).length > max) p.push(`the post is ${Array.from(i.status).length} characters; this server allows ${max}`);
    if (i.scheduled_at && Date.parse(i.scheduled_at) - now.getTime() < MASTODON_MIN_SCHEDULE_MS) p.push("scheduled posts must be at least 5 minutes in the future");
    return p;
  },
  async execute(i, ctx) {
    const { base, token } = mastodonBase(ctx);
    if (i.scheduled_at && Date.parse(i.scheduled_at) - ctx.now().getTime() < MASTODON_MIN_SCHEDULE_MS) throw new IntegrationError("validation", "the scheduled time is now less than 5 minutes away; revise the post");
    const form = new URLSearchParams({ status: i.status, visibility: i.visibility });
    if (i.scheduled_at) form.set("scheduled_at", i.scheduled_at);
    if (i.language) form.set("language", i.language);
    const res = await request(mastodon, { method: "POST", url: `${base}/api/v1/statuses`, headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": ctx.idempotencyKey }, body: form.toString() }, ctx, { safeToRetry: true, timeoutMs: this.timeoutMs });
    const j = parseJsonBody<{ id: string; url?: string; scheduled_at?: string }>(res);
    return { id: String(j.id), url: j.url ?? null, scheduled_at: j.scheduled_at ?? null };
  },
  externalId: (o) => o.id,
};

export const PROVIDER_LIST = [resend, hubspot, slack, google, linear, stripe, mastodon];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ACTION_LIST: ActionDefinition<any, any>[] = [
  resendSendEmail,
  hubspotSearchContacts, hubspotCreateContact, hubspotUpdateContact, hubspotCreateCompany, hubspotGetDeals, hubspotListDealStages, hubspotUpdateDeal, hubspotSearchTickets, hubspotUpdateTicketStage,
  slackListChannels, slackPostMessage,
  googleFreeBusy, googleCreateEvent,
  linearCreateIssue, linearCreateBlocker,
  stripeListOpenInvoices,
  mastodonInstanceLimits, mastodonPostStatus,
];
/** Resets cached OAuth tokens (tests). */
export const resetProviderState = () => {
  googleToken = null;
};
