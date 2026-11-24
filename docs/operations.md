# Operations runbook

How to keep a 100 Workflows installation healthy: back it up, restore it, upgrade it, handle incidents, rotate credentials and re-verify workflows. This is a single-user, local application; see [deployment.md](deployment.md) and [security.md](security.md).

## Monitoring

- `GET /api/health` returns 200 when:
  - the database is usable;
  - all migrations are applied;
  - the catalog loaded.

  Otherwise it returns 503 naming the failing part. Poll it from a process manager with `curl -fsS http://127.0.0.1:3000/api/health`.
- **Runs & results** (`/runs`) shows every run, a "needs review" or "failed" status per workflow, and per-workflow outcomes. Actions waiting for approval are counted on each run.
- **Workflow quality** (`/quality`) shows readiness per workflow, failing checks, stale evidence and the release gate.
- Server logs are JSON lines on stdout and stderr, with secrets redacted. Useful events: `run.started`, `run.workflow_finished`, `run.finished`, `action.succeeded`, `action.failed`.

## Backups

Everything worth keeping is under `data/` (database and builder workflows) and in `.env.local` (settings and secrets).

```bash
sqlite3 data/100-workflows.db ".backup data/backup-$(date +%Y%m%d).db"   # safe while the server runs
cp -R data/custom-workflows data/custom-workflows-backup-$(date +%Y%m%d)
```

Keep `.env.local` in a password manager, not with the backups.

## Restore

1. Stop the server.
2. Copy the backup over `data/100-workflows.db`. Remove any `data/100-workflows.db-wal` and `-shm` files that belong to the old database.
3. Start the server. Pending migrations apply automatically; check `/api/health`.
4. Runs that were in progress when the backup was taken show as **Interrupted**. Start them again.
5. Restored evidence keeps its fingerprints. Anything verified against older code or definitions shows as **stale** until you re-verify.

## Migrations

- Migrations are numbered, additive SQL files in `migrations/`. They are applied automatically at startup, or with `npm run db:migrate`.
- An applied migration that has since been edited is refused. Never edit one: add a new file.
- Before upgrading, take a backup. After upgrading, check `/api/health` (it reports pending migrations), then run `npm run quality:verify`.

## Incidents

| Symptom | First steps |
| --- | --- |
| Runs fail with a model error | Settings → Check connection. A key error (401/403) means rotate the key; a rate limit (429) means wait and retry; overloaded (529) is temporary. |
| A workflow often needs review | `/runs` per-workflow outcomes; open a run's **Quality checks** tab to see which check fails. Compare with `/quality/<id>`. |
| An action shows **unconfirmed** | The provider may or may not have performed it. Check at the provider *before* doing anything else; never re-approve blindly. |
| An action **failed** with `auth_invalid` or `permission_denied` | Rotate or re-scope that provider's credential (below). |
| Health check returns 503 | The body names the part: database, migrations or catalog. Restore from backup, apply migrations, or fix the definition named by `npm run catalog:validate`. |
| Suspected credential exposure | Revoke the credential at the provider at once, rotate it (below), and review Settings → Security and each action's audit trail. |

To turn every external action off immediately, remove `WORKFLOWS_ACTIONS=live` from `.env.local` and restart. Approvals then end as dry runs.

## Credential rotation

1. Create the new key or token at the provider with the minimum permissions listed in [integrations.md](integrations.md).
2. Replace the value in `.env.local` and restart.
3. Revoke the old one at the provider.
4. Check the connection: for the model, use Settings → Check connection; for a provider, approve one low-risk action in dry-run mode, then live.
5. If `WORKFLOWS_ACCESS_TOKEN` changed, everyone has to sign in again (old session cookies stop working).

## Re-verification

Readiness evidence goes stale automatically when:
- a workflow's definition changes;
- the runtime code it depends on changes;
- a component it uses gets a new version (tool, calculation, provider action, golden dataset).

After any change:

```bash
npm run check             # types, tests, catalog
npm run quality:verify    # mocked readiness harness + platform suites (free)
npm run quality:release   # release gate: lists blockers and stale evidence
```

Live verification spends credits and needs the owner's approval each time. See [quality.md](quality.md#live-verification).
