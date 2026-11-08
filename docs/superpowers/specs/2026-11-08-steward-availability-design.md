# Steward · Availability v1 — design

**Date:** 2026-11-08
**Status:** approved in conversation on 2026-11-08; the implementation plan follows this document.
**Owner:** Naftali Urison

## 1. What Steward is

Steward is an AI colleague for Slack. You tell it what you need in plain words; it reads your work tools on your behalf, shows you what it understood and what it is about to change, acts only on your yes, and then shows you a receipt of what it did — with Undo.

Steward is one codebase with one core and several products on it. The core owns the Slack surface, connections to other tools, the act-with-receipt engine, scheduling, budgets, audit and evaluation. Products are packs of capabilities on that core. The first product is **Steward Availability**; the second, **Steward Assistant** (open-ended, tool-using), comes after Availability runs in production and is out of scope here.

## 2. Availability: the problem and the product

When you are out, travelling or working from home, the fact lives in five places: your Slack status, your calendar, your email auto-reply, your team's view of the week, and the heads of the people who need to find a time with you. People update one or two and the rest go stale.

Steward Availability lets you say it once — in Slack, in plain words — and sets it everywhere, visibly and reversibly. It also handles the other half of availability: finding a time that works for a group and booking it with an agenda.

**Who it is for.** Teams on Slack and Google Workspace, from five people to a few hundred. Every Slack workspace that installs it is a tenant; every person connects their Google account once.

**Success for v1.** A public link, live within about a month of starting, that a hiring manager or a prospective buyer can open and in three minutes: try every flow in a browser demo with sample people, read how it is built, and install it in their own Slack. Monthly running cost on free tiers only.

## 3. Principles

These decide behaviour wherever the detailed design is silent.

1. **Parse, then review.** Plain words never cause a write directly. The person sees what was understood, assumptions are listed, uncertain fields are marked, and nothing is saved until Save.
2. **Act only on a yes.** Every write to an external system is tied to an explicit tap or command from the person it affects.
3. **Receipts, and Undo.** Every write produces a per-system receipt line — done, failed, skipped — and can be undone for five minutes.
4. **Honest states.** Unknown, failed and skipped are distinct and worded plainly. No silent fallbacks; nothing is reported as fine that was not checked.
5. **Ask, don't act.** Reminders and suggestions are offers with buttons. Nothing proactive arrives at night, on the person's weekend or while they are out; it waits for their next working morning. Every offer has "Don't ask again".
6. **One save path.** Form, plain words, quick tap, reminder buttons and scheduled fires all go through the same save and produce the same receipt.
7. **Privacy by masking.** Teams see only three labels — Out of office, Travelling, Remote — never the reason. Anyone can hide from team views.

## 4. Scope of v1

### 4.1 Status

**Doors.**
- `/ooo` opens the status form.
- `/ooo <plain words>` (e.g. `/ooo vacation thu to tue`, `/ooo remote tomorrow morning`) parses the words and opens the form pre-filled for review.
- A DM to Steward, or an @mention, in plain words: same as above, with a "Reading your request…" placeholder while parsing.
- The Home tab: three quick picks — **Sick today**, **Remote today**, **Off tomorrow** (next working day, weekend-aware) — each reusing last time's emoji, text and calendars for that type, plus "Change…" to open the form.
- Scheduled fires: a status saved for the future fires at its start without the person doing anything.

**Types.** Out of office, Sick, Remote, Travelling (with a city). A part-of-day modifier: morning ("back at 14:00") or afternoon ("out from 14:00").

**The form.** What's happening (type) · From / To dates · All day toggle · then, below a divider: Text and emoji · Calendars (multi-select of the person's connected calendars) · Cover person · Repeat weekly (days picker). A caption states which systems will be written for that type. When the form was opened from plain words, a block above it shows the person's words, "Here's what I understood", the assumptions made ("Includes Fri–Sat", "Assumed 09:00–18:00"), and "(check)" after any field the parser was unsure of. Unreadable text opens an empty form with the words shown above it. Words that describe two statuses are refused: "This sets one status at a time — which first?"

**Writes.** For each status, by type, the person's settings decide which systems are written:
- Slack profile status with text, emoji and expiry — always.
- Google Calendar: one out-of-office event on each chosen calendar; on the primary calendar it uses Google's out-of-office event type so meetings in the period are declined automatically.
- Gmail vacation responder, from a per-type template with placeholders (dates, cover person).
- Slack Do Not Disturb for the period — optional, off by default.

Future-dated statuses write Calendar and Gmail at save time (those systems accept future dates) and write Slack at the start. Ended statuses clear the Slack status, end the responder and leave the calendar event as a record.

**The result card.** Private to the person: a headline ("Out of office · Thu 12 – Tue 17 Nov"), one line per system with ✅ done / ❌ didn't go through / ➖ skipped and a plain reason, and buttons **Undo** (five minutes), **Edit**, **Clear status**. Saving over an existing status says "Replaced your earlier Remote (today)" with "Set the previous one again".

**Scheduling.** Weekly rules ("every Friday remote") materialise occurrences fourteen days ahead; a rule can be paused; editing or cancelling a rule cascades to its future occurrences. Partial days adjust the Slack expiry and the calendar event times.

**Team view.** `/ooo team` and the Home section "Out around you" show the current week for the people in the channel (or the person's chosen team): only Out of office, Travelling or Remote, dates, and the cover person if any. The card says which group it is showing. `/ooo who <name>` answers for one person. "Hide me from team views" removes a person entirely; the masking policy is one function, property-tested.

**Asks.** The evening before a status starts: "Starts tomorrow: Out of office until Tue. Fine / Change… / Cancel". The morning it ends: "Ends today at 18:00. Extend… / End now / Fine". On return: "Welcome back — your status is cleared". Opt-in capture: when a person sets a Slack status by hand that looks like absence, Steward offers "Set Calendar and Gmail to match? Yes / Not this time / Don't ask again". All of these obey quiet hours.

**Cover.** A status can name a cover person, who gets one DM ("Dana named you as cover Thu–Tue — Got it / I can't"). Cover appears in the Slack status text, the auto-reply and team views.

### 4.2 Meetings

**Find a time.** `/meet` with plain words ("30 min with Dana and Omer this week about the launch review") or the same in a DM. Steward resolves the people, duration, window and topic, then offers **three slots**, half-hour aligned, that fit everyone's Google free/busy (for connected people), declared working hours, local holidays and shared absences; it says who was checked and who could not be ("Omer hasn't connected Google — used his working hours"). **Book** creates a Calendar event with a Meet link, attendees and an agenda drafted from the words, editable before sending; the organiser gets a receipt with **Undo / Move / Cancel**. Receipts are private; nothing is posted to channels. Attendees see an ordinary calendar invitation in the organiser's name.

**Meet about this.** A message shortcut on a thread proposes the thread's participants as attendees and a two-line summary of the thread as the agenda, then runs the same three-slot flow.

### 4.3 Trips

A trip is a Travelling status with a city and dates. Team views show Travelling; `/ooo who's in Berlin` (or the Home tab) lists who is in a city in a given week. Meeting slots for a travelling person use the destination's working hours.

### 4.4 Settings

In the web app (Sign in with Slack) and mirrored in the Home tab: connect or disconnect Google; choose calendars; per-type templates (text, emoji, Gmail subject and body, which systems to write); working hours and weekend days; hide me from team views; default cover person; delete my data.

### 4.5 Not in v1

Jira, Workday or other HR systems, GitLab/GitHub statuses, PagerDuty, Microsoft 365, org-wide shared calendars, manager digests, channel topic lines, an admin console. Each is a later pack or a later connector; nothing in v1's design blocks them.

## 5. Architecture

### 5.1 Shape

A pnpm monorepo in TypeScript:

- `packages/core` — tenancy (workspace, person, connection); the Slack surface (HTTP receiver with signature verification, routing of events, commands, shortcuts and interactions; Block Kit helpers; view-state helpers); the connector interface and registry, each connector with a real and a fake implementation; the act-with-receipt engine (plan → execute → receipt → undo window); the jobs table and the minute tick; the LLM client with per-tenant budgets; the audit log; evaluation utilities.
- `packages/availability` — status types and settings, the parser and resolver, the review form, fan-out plans by type, scheduling and weekly rules, team view and masking, asks, meetings, trips.
- `packages/assistant` — a placeholder until the second product.
- `apps/worker` — one Cloudflare Worker on Hono: `/slack/events`, `/slack/interactions`, `/slack/commands`, `/oauth/slack/*` (install and Sign in with Slack), `/oauth/google/*`, `/api/*` for the web app, `/demo/*` for the emulator, and the `scheduled()` cron handler. Bindings: D1 (database), secrets, static assets for the web app.
- `apps/web` — React, Vite, Tailwind: the product page, the "How it's built" page, the demo emulator and the settings app. Built to static assets served by the Worker.

### 5.2 Runtime

Cloudflare Workers (no cold starts, free cron triggers), D1 as the database through Drizzle ORM, Google APIs over plain `fetch`, the Anthropic SDK over `fetch`. The Slack layer is written in-house rather than taken from a library: request-signature verification, three HTTP routes, and the Web API over `fetch` behind one `SlackClient` interface — about 150 lines — so that the fake client the demo and the tests use is a drop-in twin of the real one (decided 2026-11-08 while planning). One deploy from GitHub Actions on `main`.

### 5.3 Connectors

A connector exposes typed operations (for Google Calendar: list calendars, create out-of-office event, delete event, free/busy, create event with Meet; for Gmail: set and clear the vacation responder; for Slack profile: set and clear status, set DND) and declares, for each write, how to undo it. Real connectors call the APIs with the person's encrypted tokens. Fake connectors keep their state in the database under the demo session and expose it to the emulator's side panel. The engine does not know which it is talking to.

### 5.4 The act-with-receipt engine

A save produces a **plan**: one target per (status, system). Execution runs targets independently; one failing never blocks another. Each target records its external id, its state (pending, done, failed, skipped, undone), attempts and the last error in plain words. The receipt card is rendered from target rows, so it is always true to the record. Undo reverses each done target using the connector's declared inverse and records the result. Every write uses an idempotency key derived from the target id so a retry after a timeout cannot create a duplicate.

### 5.5 The tick

The cron trigger calls the Worker every minute. The tick, bounded in time and batch size: fires statuses whose start has arrived (Slack write); ends statuses whose end has passed; sends asks that are due, deferring any that would land outside the person's working hours to their next working morning; materialises weekly rules fourteen days ahead; retries failed targets with exponential backoff and gives up after six attempts with a DM; expires undo windows; cleans demo sessions older than an hour. Work is claimed with a single update so two overlapping ticks cannot run the same job.

### 5.6 The demo

The product page's "Try the demo" creates a demo session: a demo tenant with a seeded sample team (names, time zones, calendars, a few existing statuses), a fake Slack client and fake connectors scoped to that session. The emulator in the browser is a Slack-inspired workspace: a channel, a DM with Steward, the Home tab. It renders the real Block Kit the app produced and, on any tap or submitted form, sends the same interaction payload Slack would send. A side panel shows the state of the fake systems — "Calendar: Out of office Thu 12 – Tue 17 (primary)", "Gmail: auto-reply on", "Slack status: 🌴 Out of office until Tue". Time can be advanced in the panel so scheduled fires and reminders can be watched. Styling is Slack-inspired; no Slack marks are used; a note says so.

The Block Kit renderer covers the blocks the product uses: header, section (text, fields, accessory), actions (buttons, static select, date picker, overflow), context, divider, and in modals the input blocks (plain text, static select, multi-select of users, date and time pickers, checkboxes). Any unknown block renders as a visible "unsupported block" box so gaps are seen, not hidden.

## 6. Parsing

The parser turns a sentence into a structured proposal. It never acts.

**Input to the model:** the sentence; the person's time zone, working hours and weekend days; a fourteen-day local calendar table (date, weekday, holiday name if any) starting today; the four types. **Output (JSON, validated against a schema):** type; start date and end date as local calendar dates; part of day (none, morning, afternoon) with an optional time; weekly days if the sentence describes a rule; a city if named; per-field confidence (high/low); a list of assumptions in plain words; or a refusal reason ("two statuses", "not about availability"). The model does no time-zone arithmetic: local dates in, local dates out; the resolver turns dates into instants using the person's zone and hours.

**Model.** The smallest current Claude model (Haiku), temperature zero, with a hard monthly token cap per tenant; when the cap is reached the parser falls back to rules and says so in the review block.

**Rules fallback.** A deterministic parser for the common shapes — today, tomorrow, weekday names, "thu to tue", "next week", "until 3", "from 2pm", type keywords — used when the model is unavailable, over budget or returns invalid JSON. Its results are always marked low confidence.

**Evaluation.** A golden bank of sentences with expected fields, run against the model in CI (recorded replies replayed by default; live weekly) with a pass threshold; failures block merge.

## 7. Data model

All tables carry `workspace_id`; demo rows additionally carry `demo_session_id` and are deleted on expiry.

- `workspaces` — Slack team id, bot token (encrypted), install state, plan limits, monthly LLM budget.
- `people` — Slack user id, display name, time zone, working hours, weekend days, hide-from-team, default cover, quiet-hours preference, asks opt-outs.
- `google_connections` — person, encrypted refresh/access tokens, granted scopes, chosen calendars with per-calendar settings, connection health.
- `type_settings` — person × type: emoji, text, Gmail subject and body templates, which systems to write, DND on/off.
- `statuses` — person, type, start, end, part of day, text, emoji, cover person, city, source (form, words, quick pick, rule, capture), state (scheduled, active, ended, cancelled), replaced_status id.
- `status_targets` — status, system, external id, state (pending, done, failed, skipped, undone), attempts, next attempt at, last error, idempotency key.
- `rules` — person, type, weekdays, window, paused, last materialised through.
- `jobs` — kind, due at, payload, state (due, claimed, done, failed), attempts, claimed at.
- `asks` — person, kind, payload, send after, sent at, answered with.
- `meetings` — organiser, attendees, duration, window, chosen slot, agenda, calendar event id, state.
- `audit` — who, what, on which system, when, result, idempotency key.
- `llm_usage` — workspace, month, input and output tokens, estimated cost.
- `demo_sessions` — id, created at, seeded team.

Retention: ended and cancelled statuses are deleted after 30 days, asks after 30 days, audit after 365 days, LLM usage after 13 months. "Delete my data" removes the person's rows and revokes their Google tokens.

## 8. Integrations

**Slack.** Bot scopes: `commands`, `chat:write`, `users:read`, `im:history`, `app_mentions:read`, `channels:read`, `groups:read`, `channels:history`, `groups:history` (the last two only for "Meet about this" in channels Steward has been added to). User scopes, granted per person on first use: `users.profile:write` (set their status) and optionally `dnd:write`. Events: `app_home_opened`, `app_mention`, `message.im`, `user_change` (for capture, opt-in), `tokens_revoked`, `app_uninstalled`. Interactivity: block actions, view submissions, a message shortcut. Public distribution is enabled so any workspace can "Add to Slack"; App Directory listing is not part of v1.

**Google.** Per-person OAuth with scopes `calendar.events`, `calendar.calendarlist.readonly`, `calendar.freebusy`, `gmail.settings.basic`, `openid`, `email`. Until the OAuth app passes Google's verification the consent screen warns and the app is limited to 100 users; the demo does not use Google at all, so this does not affect the public link.

**Anthropic.** One API key held as a Worker secret; usage recorded per tenant; a global monthly cap in addition to per-tenant caps.

## 9. Error handling

Every external call has a timeout and a typed outcome. A failed target shows "didn't go through — <reason in plain words>" and is retried in the background; the person is told once if it is given up on. A skipped target says why ("kept the status you set by hand", "no Google connected"). A disconnected or revoked Google token marks the connection unhealthy, skips its targets with that reason, and the Home tab shows a "Reconnect Google" card. Parsing failures open the empty form with the words shown. Nothing is reported as done that was not read back or confirmed by the API response.

## 10. Security and privacy

Slack request signatures are verified on every call; OAuth flows carry a signed `state`; tokens are encrypted at rest with AES-GCM under a key held as a Worker secret, never logged; every query is scoped by `workspace_id`; the audit log records every read of another person's calendar and every write anywhere; scopes are the minimum listed above; retention is enforced by the tick; "Delete my data" is available in Settings. The demo stores no personal data of visitors.

## 11. Testing

- **Unit (Vitest):** the resolver (local dates to instants across zones and weekends), the rules parser, the fan-out planner, scheduling and rule materialisation, undo inverses.
- **Property tests:** the masking function (no reason ever leaks; hidden people never appear) and idempotency keys.
- **Flow tests:** the whole Worker driven with Slack-shaped payloads against fake connectors: set from words → review → save → receipt → undo; scheduled fire; weekly rule; team view; meeting booking; "Meet about this".
- **Parsing eval:** the golden bank, replayed in CI, live weekly.
- **End to end (Playwright):** the demo emulator, every flow clickable.
- **CI (GitHub Actions):** Biome, type check, unit and flow tests, eval gate, then deploy to Cloudflare on `main`. A public repository; the licence is Business Source 1.1.

## 12. Delivery

Weeks are indicative; order is binding.

1. **Week 1 — core and the first door.** Repository, Worker skeleton, D1 schema and migrations, Slack install flow, the engine with fake connectors, `/ooo` form → Slack status write → receipt → Undo, the demo session and a first version of the emulator rendering real Block Kit.
2. **Week 2 — words and systems.** Parser and review block, rules fallback, eval bank; Google OAuth, Calendar and Gmail connectors (real and fake); scheduled statuses, the tick, weekly rules.
3. **Week 3 — the team and the asks.** Team view and masking, Home tab, quick picks, asks with quiet hours, capture, cover; emulator side panel and time control.
4. **Week 4 — meetings and the link.** Find a time, Book, Meet about this, trips; settings web app; product page and "How it's built"; Playwright; the public link.

Owner tasks that only the account holder can do: create the Slack app and paste the manifest; create the Google Cloud OAuth client; create the Cloudflare account and the Anthropic API key; set the Worker secrets (Slack signing secret and client secret, Google client secret, Anthropic API key, token-encryption key).

## 13. Later

Steward Assistant on the same core (open-ended questions and actions across Jira, Confluence, GitHub/GitLab and Google, with approval cards and read-back); Microsoft 365 connectors; HR-system mirroring; org-wide calendars; manager digests. Each arrives as a pack or a connector without changing the core's contracts.
