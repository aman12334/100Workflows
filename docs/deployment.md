# Running and deploying

100 Workflows is built to run **on your own computer** for one person. It has not been hardened, load-tested or reviewed for hosting on the public internet, so **don't host it publicly**.

## Local (recommended)

```bash
npm install
npm run setup            # or copy .env.example to .env.local and set one model key
npm run dev              # http://127.0.0.1:3000
```

Production mode on the same machine:

```bash
npm run build
npm start                # binds to 127.0.0.1:3000
```

Migrations run automatically when the server first opens the database. To run them yourself, use `npm run db:migrate`. They are numbered and additive. An already-applied migration that was edited is refused instead of being applied differently.

## Sharing on a private network (only if you need to)

1. Set `WORKFLOWS_ACCESS_TOKEN` to a long random value (24+ characters), for example the output of `openssl rand -base64 32`.
2. Add the hostname you'll use to `WORKFLOWS_ALLOWED_HOSTS`.
3. Put an HTTPS reverse proxy (Caddy, nginx) in front of it, so the session cookie is `Secure` and the token isn't sent in clear text.
4. Bind `next start` to the private interface only. Never use `0.0.0.0` on a public network.

Everyone with the token shares one identity and full access, including approving external actions. See [security.md](security.md).

## Health checks

`GET /api/health` returns 200 when the database is usable, all migrations are applied and the catalog loaded. Otherwise it returns 503 with the failing part. It doesn't need sign-in and reveals no settings, so a process manager can poll it:

```bash
curl -fsS http://127.0.0.1:3000/api/health
```

## Data and backups

| What | Where |
| --- | --- |
| Database: packages, runs, actions, context, file text, audit | `data/100-workflows.db`, or `WORKFLOWS_DB_PATH` |
| Builder workflows | `data/custom-workflows/`, or `WORKFLOWS_CUSTOM_DIR` |
| Settings and secrets | `.env.local` |

All three are git-ignored. To back up, stop the server and copy `data/`, or use `sqlite3 data/100-workflows.db ".backup backup.db"` while it's running.

## Settings reference

See `.env.example`. The settings that change behaviour the most:

| Setting | Default | Effect |
| --- | --- | --- |
| `WORKFLOWS_ACTIONS` | off | `live` lets approved actions reach providers. Otherwise approvals end as dry runs. |
| `WORKFLOWS_ACCESS_TOKEN` | unset | Requires sign-in for every page and API |
| `WORKFLOWS_OPERATOR` | `local user` | The approver name recorded in the audit trail |
| `WORKFLOWS_WEB_SEARCH`, `WORKFLOWS_WEB_FETCH` | off | Paid web search and local page fetching for research workflows |
| `WORKFLOWS_MODEL_REVIEW` | on | One extra model call per attempt to grade outputs |

## Readiness

The evidence supports **local, single-user use**:
- the test suite passes (mocked model and providers);
- the production build passes;
- migrations are additive.

It does **not** support public or multi-tenant hosting. The automated tests have not exercised real provider credentials. Try each integration with a low-risk action before relying on it (see [integrations.md](integrations.md)).
