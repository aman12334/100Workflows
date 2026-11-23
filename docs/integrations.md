# Integrations and approvals

Ten workflows act on other services: email, CRM, calendar, tasks, Slack, invoices, social posts and support tickets. They follow one rule: **a workflow can read, draft and propose, but never act on its own.** Every send, post, create or update is a *proposed action* that runs only after a person approves its exact payload, and only once.

Everything on this page runs on your computer, with credentials you put in `.env.local`. None of these providers is connected by default.

## How an integration workflow runs

1. **Read** (optional). A check step with `reads` runs registered read-only actions, such as looking up contacts or reading free/busy. The results go to the model as fenced `<integration_data>` blocks. If a read fails, the run fails and nothing is drafted.
2. **Draft.** One generate step writes the content and the actions it proposes, as structured output.
3. **Check.** A check step with `propose` turns output items into actions. The critical rule `valid_action_payloads` checks each one:
   - it is parsed with the action's registered input schema;
   - the action's own checks run against the data read in this run, for example:
     - the Slack channel is one the bot belongs to;
     - the contact isn't already in HubSpot;
     - the calendar slot is free for everyone;
     - the deal stage exists, the deal isn't closed and something actually changes;
     - the post fits the server's character limit;
     - the ticket was read in this run;
   - an optional `field` must be a value read in this run, for example that a reminder goes to that invoice's own billing email.

   An output with an invalid action needs review, and no actions are stored.
4. **Store.** An accepted output's actions are stored as `pending_approval` in `action_requests` (migration 006). Each one records:
   - the action and its version;
   - its side-effect class;
   - the target and a summary;
   - the exact payload and its **payload hash**, sha256 of the canonical `{action, version, input}`;
   - an idempotency key;
   - an expiry date (7 days).
5. **Approve.** On the run page you see each action's payload, hash and history, and you approve or reject each one.

## The approval state machine

```
pending_approval ──approve(payloadHash)──▶ approved ──▶ executing ──▶ succeeded | failed | unconfirmed | dry_run
      ├── reject ─────────────▶ rejected
      ├── revise(new payload) ▶ superseded   (+ a new pending action with a new hash)
      └── 7 days pass ────────▶ expired
```

- **Payload binding.**
  - The approval must quote the hash that was shown; a different hash is refused.
  - A stored payload that no longer matches its own hash, for example because it was edited in the database, is refused.
  - Both refusals are logged as `hash_mismatch`.
- **Single use.**
  - Every transition is a conditional `UPDATE … WHERE status IN (…)`.
  - A second approval, a double click or two concurrent requests can't run an action twice. Later attempts are logged as `replay_blocked`.
- **Revising changes the hash.** Editing a payload supersedes the old request and creates a new one that needs its own approval.
- **Dry run by default.**
  - Unless `WORKFLOWS_ACTIONS=live`, an approved action ends as `dry_run` and nothing is sent. The approval is still used up.
  - Approving in live mode asks for confirmation in the browser.
- **Honest outcomes.**
  - `succeeded` is recorded only when the provider confirmed the action, with its id, for example the Resend email id or the HubSpot record id.
  - `unconfirmed` means the request may or may not have happened: a timeout, a dropped connection, or a 5xx during a write that can't be retried safely. Check at the provider before trying again.
  - `failed` means the provider refused the action, with the reason by kind: `auth_invalid`, `permission_denied`, `rate_limited`, `validation`, `not_configured` and so on.
- **Partial success is visible.** Each action has its own status. Approving some actions and not others leaves a consistent state. For example, a Linear "blocks" relation fails until both of its issues have been created.
- **Audit trail.** `action_events` is append-only. It records each step: proposed, approved (with the approver name), executing, the outcome, plus rejected, superseded, expired, replay_blocked and hash_mismatch. Set the approver name with `WORKFLOWS_OPERATOR`; the default is "local user".

## Side-effect classes

| Class | Meaning | Needs approval |
| --- | --- | --- |
| `read_only` | Reads data; changes nothing | no (runs during the workflow) |
| `draft` | Creates something only you can see | yes |
| `reversible_write` | Creates or changes a record you can edit or delete afterwards (CRM, calendar, tasks, ticket stage) | yes |
| `external_side_effect` | Something other people see (Slack post, scheduled social post) | yes |
| `irreversible` | Can't be taken back (an email) | yes |

## Retries, rate limits, timeouts and idempotency

- **Timeouts and cancellation.** Every request has a timeout, and cancelling the run aborts it.
- **Client-side rate limit.** Each provider has a minimum gap between requests from this process, set from the provider's published limit. `Retry-After` is honoured.
- **Which requests are retried.** Only requests that are safe to repeat are retried, at most 3 times: reads, and writes protected by a provider idempotency key. A write that might have reached the provider is never repeated automatically.
- **How double execution is prevented,** per provider:
  - **Resend and Mastodon:** an `Idempotency-Key` header carrying the action's stable key.
  - **Google Calendar:** a client-chosen event id derived from that key. A second insert with the same id is reported as a duplicate, not a second event.
  - **HubSpot contacts and companies, and Linear issues:** a check right before writing for an existing record with the same email, domain or title.
  - **HubSpot deals:** the deal is re-read right before writing, and an update that would change nothing is refused.
  - **Slack posts:** single-use approval only. Slack has no idempotency key, so an unclear outcome is `unconfirmed` and is never retried.

## Providers

Settings go in `.env.local`. Restart `npm run dev` after changing them. Settings → Integrations shows which settings are missing, by name only; values are never shown or logged. "Settings present" does not mean the provider accepted them: the first real call proves the credentials.

**Resend** (email): actions `resend.send_email@1`.
- Settings: `RESEND_API_KEY`, `RESEND_FROM`.
- Permissions: a key with sending access, and a verified sending domain.

**HubSpot** (CRM): actions `search_contacts`, `create_contact`, `update_contact`, `create_company`, `get_deals`, `list_deal_stages`, `update_deal`, `search_tickets`, `update_ticket_stage`.
- Settings: `HUBSPOT_ACCESS_TOKEN`, from a private app.
- Scopes: `crm.objects.{contacts,companies,deals,tickets}.{read,write}`.

**Slack**: actions `list_channels`, `post_message`.
- Settings: `SLACK_BOT_TOKEN`.
- Bot scopes: `chat:write`, `channels:read`, `groups:read`. Invite the bot to the channels it may post in.

**Google Calendar**: actions `free_busy`, `create_event`.
- Settings: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, and optionally `GOOGLE_CALENDAR_ID`.
- Scopes: `calendar.freebusy`, `calendar.events`. You obtain the refresh token yourself; this app has no OAuth redirect flow.

**Linear** (tasks): actions `create_issue`, `create_blocker`.
- Settings: `LINEAR_API_KEY`, `LINEAR_TEAM_ID`.
- Permissions: a personal API key, which acts with that member's access.

**Stripe** (invoices, read only): actions `list_open_invoices`.
- Settings: `STRIPE_API_KEY`.
- Permissions: a **restricted** key (`rk_…`) with Invoices: Read. Full secret keys (`sk_…`) are refused.

**Mastodon** (social): actions `instance_limits`, `post_status`.
- Settings: `MASTODON_INSTANCE_URL`, `MASTODON_ACCESS_TOKEN`.
- Scopes: `write:statuses`, `read:accounts`.

The exact endpoints, documentation links and limits are in `src/lib/integrations/providers.ts`. API details were checked against each provider's public documentation. Where the documentation didn't settle a question, the workflow does less instead of guessing:

- **HubSpot tasks and notes:** not used, because their properties couldn't be verified. Tasks go to Linear instead.
- **HubSpot ticket assignment:** not supported, because the owner property couldn't be verified.
- **Bluesky, X and LinkedIn:** not supported. Bluesky's post format couldn't be verified, and X and LinkedIn need app review. Mastodon is used for social posts instead.
- **Google Calendar duplicate events:** the API is assumed to reject a second insert with the same event id with HTTP 409, which is handled as "duplicate". This was not confirmed against a live calendar.

## What has and hasn't been tested

The automated tests are **mocked**:
- scripted model replies;
- an in-memory HTTP transport that returns canned provider responses.

They prove the workflow, validation, approval, idempotency and error-handling logic. They are **not** real provider integration tests. No request was sent to any provider while building or testing this. Before relying on a provider, approve one low-risk action in live mode, for example a Slack post to a test channel, and check the result at the provider.

## Turning real actions on

1. Add one provider's settings to `.env.local`.
2. Run the workflow and approve an action. With actions off it ends as `dry_run`; check its payload.
3. When you're ready, set `WORKFLOWS_ACTIONS=live` and restart. From then on, approving performs the action.
