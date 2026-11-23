# Security model

100 Workflows is a **single-user, local application**. It has no user accounts, roles or multi-tenant isolation. Everything below describes what it does protect against, and what it doesn't.

## Who can reach it

- **Local only by default.** The server binds to `127.0.0.1`. API routes accept only requests addressed to `localhost`, `127.0.0.1` or `[::1]`, which blocks DNS rebinding. `WORKFLOWS_ALLOWED_HOSTS` adds more hostnames.
- **Cross-site requests are blocked.** A request that changes something must:
  - carry a same-origin `Origin` header;
  - be sent as `application/json`, which forces a CORS preflight that the app never approves.

  This stops another browser tab from approving actions or starting runs.
- **No framing.** Every page sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`, so approve buttons can't be clickjacked. It also sends `nosniff` and `no-referrer`.
- **Optional sign-in.** Set `WORKFLOWS_ACCESS_TOKEN` (24 or more characters) before making the app reachable by anyone else.
  - Every page and API then requires a session cookie: `HttpOnly`, `SameSite=Strict`, and `Secure` over HTTPS. The cookie holds an HMAC of the token, never the token itself.
  - Tokens are compared in constant time, and failed sign-ins are limited to 5 per minute.
  - Sign-in attempts are recorded in the audit log.
  - A token shorter than 24 characters locks everything, so a misconfiguration fails closed.
  - Anyone with the token has full access. There is one shared identity, not per-user permissions.
- **Public health check.** `/api/health` is reachable without signing in and reports only counts and states.

## Secrets

- Model keys and provider credentials are read from the environment (`.env.local`, which is git-ignored) when they're used. They are never:
  - stored in the database;
  - put in workflow definitions or prompts;
  - logged;
  - returned by any API or shown in the UI. Settings shows only the *names* of missing settings.
- Provider error messages are cut short, and long token-like strings in them are replaced with `[redacted]` before they are stored.
- The tests check that fake credentials never appear in prompts, outputs, run records, action records or tool logs.
- The Stripe integration refuses full secret keys and accepts only restricted read-only keys.

## External actions

See [integrations.md](integrations.md). In short:
- Nothing runs without the approval of an exact payload hash.
- Each approval can be used once.
- Actions are dry-run unless `WORKFLOWS_ACTIONS=live`.
- Outcomes are recorded honestly (`unconfirmed` is never reported as success).
- Every step is audited.

## Untrusted content

- **Model output is data.**
  - It is parsed against JSON schemas and checked by deterministic rules.
  - It is never executed.
  - It can't call tools or providers directly. Reads are declared in the workflow definition, and writes need approval.
- **Web pages** (`WORKFLOWS_WEB_FETCH=on`) are fetched with GET only, from public addresses only (SSRF protection), with size and redirect limits. See [tools.md](tools.md).
- **Uploaded files** are parsed by a small built-in extractor. Only the extracted text is kept, never the file itself. The extractor:
  - checks the file type against the file's leading bytes;
  - caps sizes before and after decompression, which defends against zip bombs;
  - refuses encrypted and ZIP64 files;
  - never executes file content (no macros, no scripts).
- **Builder workflows**
  - are validated like catalog workflows;
  - can use the model only, with no tools, calculations or integrations;
  - are saved only under `data/custom-workflows/<category>/<id>.json`, with the id restricted to kebab-case so paths can't escape.

## Workspaces

This build has one workspace per installation (`local`). Workspace-scoped data (context items, files and audit events) is stored and always queried by workspace id, and tests check that one workspace can't read, change or delete another's data. Packages, runs and actions are not workspace-scoped yet: this is a single-user application.

## Audit

| What | Where |
| --- | --- |
| Approvals, rejections, revisions, executions, replays, hash mismatches | `action_events`; shown on each action |
| Sign-ins, failed sign-ins, uploads, deletions, builder saves and deletions | `audit_events`; shown in Settings → Security |
| Runs, steps, tool calls, evaluations | `runs`, `run_steps`, `tool_calls`, `evaluations`; shown on run pages |

## Not provided

- User accounts, roles, SSO or per-user permissions.
- Encryption at rest: the SQLite database is a plain file under `data/`. Protect it like any local file.
- An OAuth redirect flow: refresh tokens are obtained by you and set in the environment.
- Hardening for hosting on the public internet. Don't host this publicly; see [deployment.md](deployment.md).
