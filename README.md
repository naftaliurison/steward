# Steward

An AI colleague for Slack that acts in your work tools only on your yes, and shows you what it did.

Steward is one core — the Slack surface, connections to other tools, an act-with-receipt engine with Undo, scheduling, budgets, audit and evaluation — and products built on it.

**Steward Availability** is the first, and it is being built: you will say once, in plain words, that you're out, travelling or working remotely, and it will set your Slack status, your Google calendars and your Gmail auto-reply — reviewable before it saves, reversible for five minutes after — and find a time for a group and book it with an agenda. Today it sets the Slack status, at once or from a first day in the future.

Status: `/ooo` form → Slack status → receipt → Undo works end to end in Slack, and the same flow runs as a browser demo at `/try` against a pretend Slack. See Deploy below to run your own copy. The design is in [`docs/superpowers/specs/2026-11-08-steward-availability-design.md`](docs/superpowers/specs/2026-11-08-steward-availability-design.md); plans live in `docs/superpowers/plans/`.

## Develop

```bash
pnpm install
pnpm test                                   # unit + flow tests (Node, in-memory SQLite, fake Slack)
pnpm --filter @steward/worker db:migrate:local
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # then fill in the values
pnpm --filter @steward/worker dev           # http://localhost:8787/health
pnpm --filter @steward/web dev              # http://localhost:5173 (pages; proxies the API to :8787)
pnpm build                                  # web to apps/web/dist, then a dry-run Worker build that includes it
```

The Worker serves the built pages itself, so `pnpm --filter @steward/worker dev` needs `pnpm --filter @steward/web build` to have run once.

## Deploy (first time)

Everything below is done once by the account owner; CI deploys on every later push to `main`. The order matters: the Slack app needs the Worker's host, which exists only after the first deploy.

1. **Cloudflare.** Create an account; in *My Profile → API Tokens* create a token from the *Edit Cloudflare Workers* template and add *D1: Edit*; note the account id (shown on the Workers overview — it becomes the `CLOUDFLARE_ACCOUNT_ID` secret in step 7). Locally: `pnpm --filter @steward/worker exec wrangler login`.
2. **Database.** `pnpm --filter @steward/worker exec wrangler d1 create steward` → paste the printed `database_id` into `apps/worker/wrangler.toml`, commit. Then `pnpm --filter @steward/worker db:migrate:remote`.
3. **First deploy.** `pnpm --filter @steward/web build && pnpm --filter @steward/worker release` prints the Worker's URL, e.g. `https://steward.<account>.workers.dev`. Open `/health` there → `{"ok":true}` (no secrets are needed for that). The product page is at `/`. The demo at `/try` works once both `TOKEN_KEY` and `DEMO_ENABLED` (set to `1`) are set (step 5 shows how), before any Slack app exists.
4. **Slack app.** At api.slack.com/apps choose *Create New App → From an app manifest*, paste `apps/worker/slack-manifest.json` with `APP_HOST` replaced by the host from step 3. Under *Basic Information* copy the signing secret, client id and client secret. Under *Manage Distribution* complete Slack's activation checklist and enable public distribution.
5. **Secrets.** From `apps/worker`, one at a time: `pnpm exec wrangler secret put SLACK_SIGNING_SECRET`, `pnpm exec wrangler secret put SLACK_CLIENT_ID`, `pnpm exec wrangler secret put SLACK_CLIENT_SECRET`, `pnpm exec wrangler secret put TOKEN_KEY` (32 random bytes, base64: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`), `pnpm exec wrangler secret put APP_URL` (`https://<host>` from step 3, no trailing slash). Secrets take effect without a redeploy. Set `DEMO_ENABLED` to `1` (`pnpm exec wrangler secret put DEMO_ENABLED`) to switch the public demo at `/try` on; without it `/demo/*` answers 503.
6. **Install.** Visit `https://<host>/oauth/slack/install`, approve, then type `/ooo` in Slack.
7. **CI.** Add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; from then on every push to `main` applies migrations and deploys after the checks pass.

**After a change that adds a migration** (a new file in `packages/core/drizzle/`): CI applies it before it deploys. When you deploy by hand, run `pnpm --filter @steward/worker db:migrate:remote` first, then deploy; the new code expects the new columns.

If something goes wrong:

- In Windows PowerShell, call `pnpm.cmd` instead of `pnpm` if scripts are blocked.
- If `wrangler login` opens the wrong browser, run `wrangler login --browser=false` and paste the link into the browser where you are signed in to Cloudflare.
- Slack's create-app page shows a bot token, a user token and an app token: Steward needs none of them, only the three values under Basic Information → App Credentials.

Rotating a secret: `pnpm exec wrangler secret put <NAME>` again. Rotating `TOKEN_KEY` invalidates every stored token (people reconnect).

## Licence

Business Source License 1.1 — free to read, modify and run for your own use; not to be offered as a service to others. Each version becomes Apache 2.0 four years after release. See [LICENSE](LICENSE).
