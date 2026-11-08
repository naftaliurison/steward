# Steward

An AI colleague for Slack that acts in your work tools only on your yes, and shows you what it did.

Steward is one core — the Slack surface, connections to other tools, an act-with-receipt engine with Undo, scheduling, budgets, audit and evaluation — and products built on it.

**Steward Availability** is the first: say once, in plain words, that you're out, travelling or working remotely, and it sets your Slack status, your Google calendars and your Gmail auto-reply — reviewable before it saves, reversible for five minutes after. It also finds a time for a group and books it with an agenda.

Status: Plan 1 (core and the first door) and Plan 2a (deploy gates and hardening) built — deployable once the owner's accounts exist; see Deploy below. Plan 1 delivered `/ooo` form → Slack status → receipt → Undo, install flow, minute tick. The design is in [`docs/superpowers/specs/2026-11-08-steward-availability-design.md`](docs/superpowers/specs/2026-11-08-steward-availability-design.md); plans live in `docs/superpowers/plans/`.

## Develop

```bash
pnpm install
pnpm test                                   # unit + flow tests (Node, in-memory SQLite, fake Slack)
pnpm --filter @steward/worker db:migrate:local
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # then fill in the values
pnpm --filter @steward/worker dev           # http://localhost:8787/health
```

## Deploy (first time)

Everything below is done once by the account owner; CI deploys on every later push to `main`.

1. **Cloudflare.** Create an account; create an API token with *Workers Scripts: Edit* and *D1: Edit*; note the account id. Locally: `pnpm --filter @steward/worker exec wrangler login`.
2. **Database.** `pnpm --filter @steward/worker exec wrangler d1 create steward` → paste the printed `database_id` into `apps/worker/wrangler.toml`, commit. Then `pnpm --filter @steward/worker db:migrate:remote`.
3. **Slack app.** At api.slack.com/apps choose *Create New App → From an app manifest*, paste `apps/worker/slack-manifest.json` with `APP_HOST` replaced by the Worker's host (shown by `wrangler deploy`, e.g. `steward.<account>.workers.dev`). Under *Basic Information* copy the signing secret, client id and client secret. Under *Manage Distribution* enable public distribution.
4. **Secrets.** From `apps/worker`: `wrangler secret put SLACK_SIGNING_SECRET`, `wrangler secret put SLACK_CLIENT_ID`, `wrangler secret put SLACK_CLIENT_SECRET`, `wrangler secret put TOKEN_KEY` (32 random bytes, base64: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`), `wrangler secret put APP_URL` (`https://<host>`, no trailing slash).
5. **Deploy.** `pnpm --filter @steward/worker deploy`. Open `https://<host>/health` → `{"ok":true}`.
6. **Install.** Visit `https://<host>/oauth/slack/install`, approve, then type `/ooo` in Slack.
7. **CI.** Add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; from then on every push to `main` applies migrations and deploys after the checks pass.

Rotating a secret: `wrangler secret put <NAME>` again. Rotating `TOKEN_KEY` invalidates every stored token (people reconnect).

## Licence

Business Source License 1.1 — free to read, modify and run for your own use; not to be offered as a service to others. Each version becomes Apache 2.0 four years after release. See [LICENSE](LICENSE).
