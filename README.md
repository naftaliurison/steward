# Steward

An AI colleague for Slack that acts in your work tools only on your yes, and shows you what it did.

Steward is one core — the Slack surface, connections to other tools, an act-with-receipt engine with Undo, scheduling, budgets, audit and evaluation — and products built on it.

**Steward Availability** is the first: say once, in plain words, that you're out, travelling or working remotely, and it sets your Slack status, your Google calendars and your Gmail auto-reply — reviewable before it saves, reversible for five minutes after. It also finds a time for a group and books it with an agenda.

Status: Plan 1 (core and the first door) built — `/ooo` form → Slack status → receipt → Undo, install flow, minute tick. The design is in [`docs/superpowers/specs/2026-11-08-steward-availability-design.md`](docs/superpowers/specs/2026-11-08-steward-availability-design.md); plans live in `docs/superpowers/plans/`.

## Develop

```bash
pnpm install
pnpm test                                   # unit + flow tests (Node, in-memory SQLite, fake Slack)
pnpm --filter @steward/worker db:migrate:local
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # then fill in the values
pnpm --filter @steward/worker dev           # http://localhost:8787/health
```

## Licence

Business Source License 1.1 — free to read, modify and run for your own use; not to be offered as a service to others. Each version becomes Apache 2.0 four years after release. See [LICENSE](LICENSE).
