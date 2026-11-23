# Local HTTP API

The app's own UI uses these routes. They are served by `npm run dev` or `npm start` on `127.0.0.1:3000`.

Requests that change anything (`POST`, `PATCH`, `DELETE`):
- need a same-origin `Origin` header;
- need `content-type: application/json`;
- need the session cookie when `WORKFLOWS_ACCESS_TOKEN` is set.

Errors look like `{ "error": { "code": "...", "message": "..." } }`.

## Catalog and packages

| Method and path | What it does |
| --- | --- |
| `GET /api/catalog` | Catalog workflows plus local builder workflows |
| `POST /api/packages` | Create a package `{ workflowIds, goal?, name? }`. Dependencies are resolved. |
| `PATCH` / `DELETE /api/packages/:id` | Rename or delete a package |
| `POST /api/packages/:id/workflows` and `DELETE /api/packages/:id/workflows/:workflowId` | Add or remove a workflow |
| `POST /api/packages/:id/workflows/:workflowId/update` | Re-pin a workflow to the current catalog version |
| `PUT /api/packages/:id/inputs` | Save setup inputs |

## Runs

| Method and path | What it does |
| --- | --- |
| `POST /api/packages/:id/runs` | Start a run (202, `{ runId }`). Execution continues in the background. |
| `GET /api/runs?q=&status=&workflowId=&since=&limit=` | Run history, newest first. Each run includes a count of actions awaiting approval. |
| `GET /api/runs/:id` | The full run: steps, tool calls, evaluations and usage |
| `POST /api/runs/:id/cancel` | Cancel a running run |
| `POST /api/runs/:id/retry` | Start a new run of the same package that reuses identical accepted results and re-runs the rest |

## Proposed actions

| Method and path | What it does |
| --- | --- |
| `GET /api/actions?runId=&status=` | Proposed actions with their payload, payload hash, status and audit events |
| `POST /api/actions/:id/approve` `{ payloadHash }` | Approve the exact payload and execute it once. It is a dry run unless `WORKFLOWS_ACTIONS=live`. 409 when the hash is different, or the action was already approved, rejected, superseded or expired. |
| `POST /api/actions/:id/reject` `{ reason? }` | Reject a pending action |
| `POST /api/actions/:id/revise` `{ input }` | Replace the payload. The old action is superseded, and the new action (in the response) needs its own approval. |
| `GET /api/integrations` | `{ live, providers[] }`: which providers have their settings (by setting *name*), their actions, side effects and permissions |

## Workspace memory

| Method and path | What it does |
| --- | --- |
| `GET` / `POST /api/context` | List or create context items `{ title, body }` |
| `PATCH` / `DELETE /api/context/:id` | Update or delete a context item |
| `GET /api/files` | Uploaded files (metadata) and limits |
| `POST /api/files` `{ name, contentBase64 }` | Upload TXT/MD/CSV/DOCX/XLSX/PDF (up to 10 MB). Only the extracted text is stored. Returns 201 for a new file, 200 for a duplicate, 422 if the file can't be read. |
| `GET` / `DELETE /api/files/:id` | Get a file's extracted text, or delete the file |

## Builder

| Method and path | What it does |
| --- | --- |
| `POST /api/builder/validate` `{ spec, replace? }` | Validate a builder spec and return the definition it produces. Writes nothing. |
| `POST /api/builder/workflows` `{ spec, replace? }` | Save it to `data/custom-workflows/<category>/<id>.json` |
| `DELETE /api/builder/workflows/:id` | Delete a builder workflow. Packages that pinned it keep their snapshot. |

## Chat, configuration and operations

| Method and path | What it does |
| --- | --- |
| `POST /api/conversations` and `POST /api/conversations/:id/messages` | The recommendation chat |
| `POST /api/config/check` | Check the model key against the provider's free models endpoint |
| `POST /api/auth/login` `{ token }` and `POST /api/auth/logout` | Sign in and out (only when `WORKFLOWS_ACCESS_TOKEN` is set) |
| `GET /api/health` | `{ ok, database, migrations: { applied, pending }, catalog: { workflows, errors } }`. Returns 503 when it isn't ready. No sign-in needed, and no settings or secrets are included. |
