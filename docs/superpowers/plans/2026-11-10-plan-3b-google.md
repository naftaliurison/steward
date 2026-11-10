# Plan 3b: Google Calendar and Gmail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person connects their Google account once with `/ooo google`; from then on an "Out of office" or "Off sick" status also adds an out-of-office event to their calendar and turns on their Gmail auto-reply, each with its own line on the receipt, and Undo or Cancel takes both away again.

**Architecture:** `packages/core` gains a Google client (real and fake, like the Slack one), a `google_connections` table and a token source that hands out a valid access token and refreshes it when needed. `packages/availability` gains two connectors (`google-calendar`, `gmail-responder`) and plans their writes beside the Slack one. Google accepts future dates, so these two are written when the status is saved, also for a scheduled status; Slack is still written at the start. The Worker gains `/oauth/google/start`, `/oauth/google/callback` and the `/ooo google` command. The tick retries failed Google writes; a Google retry counts double against the per-minute limit so the free-plan ceiling holds.

**Tech Stack:** TypeScript, pnpm workspace, Drizzle ORM on Cloudflare D1 (better-sqlite3 in tests), Hono on Cloudflare Workers, Vitest 3, Biome 2. Google Calendar API v3, Gmail API v1, Google OAuth 2.0. No new packages.

## Global Constraints

- Free tiers only. D1 Free allows **50 queries per Worker invocation**; Workers Free allows **50 subrequests per invocation**, and the two may be counted together. The tick's worst case today is 44 statements and 7 outbound calls. This plan must not raise either number (Task 10 says how).
- **Never run a remote Wrangler command** (`wrangler deploy`, `wrangler d1 ... --remote`, `wrangler secret ...`). The app is live. Local tests only. The owner applies the migration and sets the secrets himself.
- No secret values anywhere in the repository, in tests, in logs or in commit messages. Tests use made-up strings such as `"client-id"` and `"ya29.access"`.
- No employer code, names, people or vocabulary anywhere in this repository.
- All text a person reads is plain words: no jargon, no blame, says what happened and what to do next.
- Every outbound HTTP call goes through the injected `GoogleClient`, `SlackClient` or `fetchFn`. Never call the bare global `fetch` as a method of another object (it throws on Workers).
- Every Google call has a timeout (`GOOGLE_TIMEOUT_MS`).
- Tokens are stored only sealed (`seal` / `open` from `@steward/core` with `TOKEN_KEY`). A token is never logged.
- The demo does not use Google at all (spec §8). Demo people never have a Google connection, so nothing in the demo changes.
- The global tick must never touch a workspace whose id starts with `demo:` (unchanged).
- Run from the repository root (`C:\Users\nafta\steward`). In PowerShell the command is `pnpm.cmd`; in Bash it is `pnpm`.
- Before every commit: `pnpm test`, `pnpm typecheck` and `pnpm lint` all pass. `pnpm exec biome check --write <files you changed>` fixes formatting; do not let it rewrite files under `docs/`.
- Commit messages end with the line `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Work on the branch `plan/3b-google`. Do not merge and do not push to `main`.

## What changes for a person

| Before | After |
|---|---|
| Steward knows nothing about Google. | `/ooo google` answers with a private link. It opens a page that names the Slack person and workspace, then Google's consent screen. Afterwards Steward is connected to that Google account. |
| "Out of office" and "Off sick" set the Slack status only. | With Google connected they also add a calendar event (Google's own out-of-office kind on the main calendar) and turn on the Gmail auto-reply for the same days. |
| A status saved for later writes nothing until it starts. | The calendar event and the auto-reply are written when it is saved (Google holds them until the day). The Slack status is still set at the start. |
| The receipt has one line. | One line per write: Slack status, Calendar event, Gmail auto-reply. A person without Google sees a one-line hint to run `/ooo google`. |
| — | If the person already has an auto-reply on, Steward leaves it alone and says so. |
| — | If Google access was taken away, the two Google lines say "Reconnect Google — run /ooo google". |
| — | `/ooo google disconnect` takes Steward's access away and forgets the tokens. |
| The last day of a status has no upper limit. | The last day must be within two years. |

## Decisions already made (do not reopen)

- **Real Google only.** The demo gets no Calendar or Gmail emulation in this plan.
- **Which types write Google:** `out` and `sick`. `remote` and `travelling` write Slack only.
- **No connection, no Google lines.** A person who never connected gets no skipped lines, only the hint. A person whose connection is unhealthy, or who did not grant a scope, gets the lines, skipped, with "Reconnect Google — run /ooo google".
- **Calendars:** the connection stores every writable calendar; only the main one is chosen. The code and tests handle several chosen calendars. There is no screen for choosing yet.
- **Main calendar:** a timed `outOfOffice` event from the first midnight to the midnight after the last day, `autoDeclineMode: "declineOnlyNewConflictingInvitations"`. If Google refuses that kind (some account types do), Steward adds an ordinary all-day busy event instead. Other calendars always get the all-day event.
- **Event id:** `stw` + the SHA-256 of the write's idempotency key in hex. A second insert answers 409, which counts as done.
- **Gmail:** Steward reads the auto-reply first. If one is on, has not ended, and is not word for word the one Steward would set, the write is skipped. Otherwise it is set with start and end times, so it ends by itself. Gmail has one auto-reply per account, so a second Steward status while an earlier one's auto-reply is still on is skipped the same way.
- **Ended statuses:** the calendar event stays as a record; the auto-reply has ended by its own end time.
- **Undo / Cancel:** deletes the event; turns the auto-reply off only if it is still the one Steward set.
- **The connect link** carries a state signed with the Slack signing secret (purpose prefix `google:`), good for 10 minutes, naming the person. The page it opens names the Slack person and workspace before Google is shown.
- **Scopes asked for** are the spec's: `openid`, `email`, `calendar.events`, `calendar.calendarlist.readonly`, `calendar.freebusy`, `gmail.settings.basic`.
- **A Google retry weighs 2** against the tick's retry limit of 2; a Slack retry weighs 1. The first due write always runs.
- **If the Google secrets are not set,** `/ooo google` says Google is not set up; everything else works as before.

## File map

| File | What it is for |
|---|---|
| `packages/core/src/db/schema.ts` (modify) | `googleConnections` table, `GoogleConnectionRow` |
| `packages/core/drizzle/0007_*.sql` (generated) | the migration |
| `packages/core/src/db/repo.ts` (modify) | read, upsert, update and delete a connection; `calendarsOf`, `hasGoogleScope` |
| `packages/core/src/db/googleConnections.test.ts` (create) | repo tests |
| `packages/core/src/google/client.ts` (create) | `GoogleClient`, `RealGoogleClient`, `GoogleApiError`, `emailFromIdToken` |
| `packages/core/src/google/fake.ts` (create) | `FakeGoogleClient` |
| `packages/core/src/google/tokens.ts` (create) | `GoogleTokenSource` |
| `packages/core/src/google/*.test.ts` (create) | their tests |
| `packages/core/src/testing.ts` (modify) | `seedGoogleConnection` |
| `packages/core/src/engine/engine.ts` (modify) | `createTargets` takes a recovery time per write |
| `packages/core/src/index.ts` (modify) | exports |
| `packages/availability/src/status/plan.ts` (modify) | system names, which types write Google, `planWrites` |
| `packages/availability/src/status/templates.ts` (create) | the auto-reply words |
| `packages/availability/src/status/form.ts` (modify) | last-day limit |
| `packages/availability/src/connectors/googleAccess.ts` (create) | token or reason, shared by both connectors |
| `packages/availability/src/connectors/googleCalendar.ts` (create) | calendar connector |
| `packages/availability/src/connectors/gmailResponder.ts` (create) | auto-reply connector |
| `packages/availability/src/status/service.ts` (modify) | save writes Google at once |
| `packages/availability/src/status/card.ts` (modify) | lines, order, notes |
| `packages/availability/src/index.ts` (modify) | exports |
| `apps/worker/src/env.ts`, `deps.ts`, `test/helpers.ts`, `.dev.vars.example` (modify) | Google client id, secret and client |
| `apps/worker/src/registry.ts` (create) | the one place the connectors are registered |
| `apps/worker/src/google/state.ts` (create) | signed state for the connect link |
| `apps/worker/src/routes/google.ts` (create) | `/oauth/google/start`, `/oauth/google/callback` |
| `apps/worker/src/slack/googleCommand.ts` (create) | `/ooo google`, `/ooo google disconnect` |
| `apps/worker/src/slack/handlers.ts`, `app.ts`, `tick.ts` (modify) | wiring; tick rules |
| `README.md` (modify) | what is true now |

---

### Task 1: The connection table

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/src/db/repo.ts`
- Modify: `packages/core/src/testing.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/drizzle/0007_*.sql` and `packages/core/drizzle/meta/0007_snapshot.json` (generated)
- Test: `packages/core/src/db/googleConnections.test.ts`

**Interfaces:**
- Consumes: `seal` from `packages/core/src/crypto/seal.ts`; `createTestDb` from `packages/core/src/testing.ts`.
- Produces (all exported from `@steward/core` unless noted):
  - `schema.googleConnections`, `type GoogleConnectionRow`
  - `type GoogleCalendar = { id: string; summary: string; primary: boolean; chosen: boolean }`
  - `getGoogleConnection(db, personId): Promise<GoogleConnectionRow | null>`
  - `upsertGoogleConnection(db, row: GoogleConnectionRow): Promise<void>`
  - `setGoogleAccessToken(db, personId, token: { accessTokenSealed: string | null; accessExpiresAt: number | null; updatedAt: number }): Promise<void>`
  - `setGoogleHealth(db, personId, health: "ok" | "revoked", updatedAt: number): Promise<void>`
  - `deleteGoogleConnection(db, personId): Promise<void>`
  - `calendarsOf(row): GoogleCalendar[]`, `hasGoogleScope(row, scope: string): boolean`
  - `GOOGLE_SCOPE = { calendarEvents, calendarList, freeBusy, gmailSettings }` (full scope URLs)
  - from `@steward/core/testing`: `seedGoogleConnection(db, tokenKey, row: Partial<GoogleConnectionRow> & { personId: string; workspaceId: string }, tokens?: { refresh?: string; access?: string | null }): Promise<GoogleConnectionRow>`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/db/googleConnections.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newKeyB64, open } from "../crypto/seal";
import { createTestDb, seedGoogleConnection } from "../testing";
import {
  calendarsOf,
  deleteGoogleConnection,
  GOOGLE_SCOPE,
  getGoogleConnection,
  hasGoogleScope,
  setGoogleAccessToken,
  setGoogleHealth,
  upsertGoogleConnection,
} from "./repo";

describe("google connections", () => {
  it("stores one connection per person, sealed, and reads it back", async () => {
    const db = createTestDb();
    const key = newKeyB64();
    const row = await seedGoogleConnection(db, key, { personId: "T1:U1", workspaceId: "T1" });
    const read = await getGoogleConnection(db, "T1:U1");
    expect(read).toEqual(row);
    expect(read?.health).toBe("ok");
    expect(read?.refreshTokenSealed).not.toContain("1//refresh");
    expect(read && (await open(key, read.refreshTokenSealed))).toBe("1//refresh");
    expect(await getGoogleConnection(db, "T1:NOBODY")).toBeNull();
  });

  it("replaces the row when the person connects again", async () => {
    const db = createTestDb();
    const key = newKeyB64();
    const first = await seedGoogleConnection(db, key, { personId: "T1:U1", workspaceId: "T1" });
    await upsertGoogleConnection(db, { ...first, email: "new@example.com", health: "ok" });
    expect((await getGoogleConnection(db, "T1:U1"))?.email).toBe("new@example.com");
  });

  it("updates the access token and the health, and deletes", async () => {
    const db = createTestDb();
    const key = newKeyB64();
    await seedGoogleConnection(db, key, { personId: "T1:U1", workspaceId: "T1" });
    await setGoogleAccessToken(db, "T1:U1", {
      accessTokenSealed: "sealed",
      accessExpiresAt: 99,
      updatedAt: 5,
    });
    await setGoogleHealth(db, "T1:U1", "revoked", 6);
    const read = await getGoogleConnection(db, "T1:U1");
    expect(read).toMatchObject({
      accessTokenSealed: "sealed",
      accessExpiresAt: 99,
      health: "revoked",
      updatedAt: 6,
    });
    await deleteGoogleConnection(db, "T1:U1");
    expect(await getGoogleConnection(db, "T1:U1")).toBeNull();
  });

  it("reads calendars and scopes, and survives a damaged calendars value", async () => {
    const db = createTestDb();
    const key = newKeyB64();
    const row = await seedGoogleConnection(db, key, { personId: "T1:U1", workspaceId: "T1" });
    expect(calendarsOf(row)).toEqual([
      { id: "dana@example.com", summary: "Dana", primary: true, chosen: true },
    ]);
    expect(calendarsOf({ ...row, calendars: "not json" })).toEqual([]);
    expect(hasGoogleScope(row, GOOGLE_SCOPE.gmailSettings)).toBe(true);
    expect(hasGoogleScope({ ...row, scopes: "openid email" }, GOOGLE_SCOPE.gmailSettings)).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run packages/core/src/db/googleConnections.test.ts`
Expected: FAIL — `seedGoogleConnection` and the repo functions do not exist.

- [ ] **Step 3: Add the table**

In `packages/core/src/db/schema.ts`, directly after the `audit` table and before the line `export type WorkspaceRow = ...`, add:

```ts
/** One row per person who connected Google. Both tokens are sealed with TOKEN_KEY. */
export const googleConnections = sqliteTable(
  "google_connections",
  {
    /** The same id as `people.id`. */
    personId: text("person_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    /** The Google account's address, shown to the person; "" when Google did not say. */
    email: text("email").notNull(),
    refreshTokenSealed: text("refresh_token_sealed").notNull(),
    /** Null until the first refresh, and after Google refused the stored one. */
    accessTokenSealed: text("access_token_sealed"),
    accessExpiresAt: integer("access_expires_at"),
    /** The scopes Google granted, separated by spaces. */
    scopes: text("scopes").notNull(),
    /** JSON: `GoogleCalendar[]` — every calendar the person can write to, and which ones Steward writes. */
    calendars: text("calendars").notNull(),
    /** ok | revoked */
    health: text("health").notNull(),
    connectedAt: integer("connected_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("google_connections_workspace_idx").on(t.workspaceId)],
);
```

After the line `export type TargetRow = typeof statusTargets.$inferSelect;` add:

```ts
export type GoogleConnectionRow = typeof googleConnections.$inferSelect;
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @steward/core db:generate`
Expected: a new file `packages/core/drizzle/0007_<two words>.sql` containing one `CREATE TABLE \`google_connections\`` and one `CREATE INDEX \`google_connections_workspace_idx\``, plus `meta/0007_snapshot.json` and a new entry in `meta/_journal.json`. If the file contains anything else (an `ALTER`, a `DROP`), stop and report.

- [ ] **Step 5: Add the repo functions**

In `packages/core/src/db/repo.ts` add `type GoogleConnectionRow` and `googleConnections` to the existing import from `./schema`, and append:

```ts
export type GoogleCalendar = { id: string; summary: string; primary: boolean; chosen: boolean };

const GOOGLE_AUTH = "https://www.googleapis.com/auth";
export const GOOGLE_SCOPE = {
  calendarEvents: `${GOOGLE_AUTH}/calendar.events`,
  calendarList: `${GOOGLE_AUTH}/calendar.calendarlist.readonly`,
  freeBusy: `${GOOGLE_AUTH}/calendar.freebusy`,
  gmailSettings: `${GOOGLE_AUTH}/gmail.settings.basic`,
} as const;

export async function getGoogleConnection(
  db: Db,
  personId: string,
): Promise<GoogleConnectionRow | null> {
  const rows = await db
    .select()
    .from(googleConnections)
    .where(eq(googleConnections.personId, personId));
  return rows[0] ?? null;
}

/** Connecting again replaces everything: new tokens, new scopes, new calendars, healthy. */
export async function upsertGoogleConnection(db: Db, row: GoogleConnectionRow): Promise<void> {
  const { personId: _personId, ...rest } = row;
  await db
    .insert(googleConnections)
    .values(row)
    .onConflictDoUpdate({ target: googleConnections.personId, set: rest });
}

export async function setGoogleAccessToken(
  db: Db,
  personId: string,
  token: { accessTokenSealed: string | null; accessExpiresAt: number | null; updatedAt: number },
): Promise<void> {
  await db.update(googleConnections).set(token).where(eq(googleConnections.personId, personId));
}

export async function setGoogleHealth(
  db: Db,
  personId: string,
  health: "ok" | "revoked",
  updatedAt: number,
): Promise<void> {
  await db
    .update(googleConnections)
    .set({ health, updatedAt })
    .where(eq(googleConnections.personId, personId));
}

export async function deleteGoogleConnection(db: Db, personId: string): Promise<void> {
  await db.delete(googleConnections).where(eq(googleConnections.personId, personId));
}

/** The calendars stored on the connection; a damaged value reads as none. */
export function calendarsOf(row: GoogleConnectionRow): GoogleCalendar[] {
  try {
    const parsed: unknown = JSON.parse(row.calendars);
    return Array.isArray(parsed) ? (parsed as GoogleCalendar[]) : [];
  } catch {
    return [];
  }
}

export function hasGoogleScope(row: GoogleConnectionRow, scope: string): boolean {
  return row.scopes.split(" ").includes(scope);
}
```

- [ ] **Step 6: Add the test seed**

In `packages/core/src/testing.ts` add the imports

```ts
import { seal } from "./crypto/seal";
import { GOOGLE_SCOPE, upsertGoogleConnection } from "./db/repo";
import type { GoogleConnectionRow } from "./db/schema";
```

and append:

```ts
/** A healthy Google connection with every scope and one main calendar. Node only. */
export async function seedGoogleConnection(
  db: Db,
  tokenKey: string,
  row: Partial<GoogleConnectionRow> & { personId: string; workspaceId: string },
  tokens: { refresh?: string; access?: string | null } = {},
): Promise<GoogleConnectionRow> {
  const access = tokens.access === undefined ? "ya29.access" : tokens.access;
  const full: GoogleConnectionRow = {
    email: "dana@example.com",
    refreshTokenSealed: await seal(tokenKey, tokens.refresh ?? "1//refresh"),
    accessTokenSealed: access === null ? null : await seal(tokenKey, access),
    accessExpiresAt: access === null ? null : Date.UTC(2030, 0, 1),
    scopes: ["openid", "email", ...Object.values(GOOGLE_SCOPE)].join(" "),
    calendars: JSON.stringify([
      { id: "dana@example.com", summary: "Dana", primary: true, chosen: true },
    ]),
    health: "ok",
    connectedAt: 0,
    updatedAt: 0,
    ...row,
  };
  await upsertGoogleConnection(db, full);
  return full;
}
```

- [ ] **Step 7: Export from the package**

In `packages/core/src/index.ts`:

- add `export type { GoogleCalendar } from "./db/repo";`
- add to the existing value export from `./db/repo`: `calendarsOf`, `deleteGoogleConnection`, `GOOGLE_SCOPE`, `getGoogleConnection`, `hasGoogleScope`, `setGoogleAccessToken`, `setGoogleHealth`, `upsertGoogleConnection`
- add `GoogleConnectionRow` to the existing type export from `./db/schema`

Keep every name that is exported today. Run `pnpm exec biome check --write packages/core/src/index.ts` to put the names in order.

- [ ] **Step 8: Run the tests**

Run: `pnpm exec vitest run packages/core`
Expected: PASS, including the new file and the existing D1 smoke test (it applies every migration file, so it now also proves 0007 runs on D1).

- [ ] **Step 9: Commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add packages/core
git commit -m "feat(core): google_connections table and its repo functions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: A Google client, real and fake

**Files:**
- Create: `packages/core/src/google/client.ts`
- Create: `packages/core/src/google/fake.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/google/client.test.ts`, `packages/core/src/google/fake.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (exported from `@steward/core`):

```ts
export type GoogleTokens = {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string | null;
  /** Granted scopes, separated by spaces. */
  scope: string;
  idToken: string | null;
};
export type GoogleCalendarEntry = { id: string; summary: string; primary: boolean };
export type GoogleEventTime = { dateTime: string } | { date: string };
export type GoogleEventInput = {
  id: string;
  summary: string;
  start: GoogleEventTime;
  end: GoogleEventTime;
  transparency: "opaque";
  eventType?: "outOfOffice";
  outOfOfficeProperties?: { autoDeclineMode: string; declineMessage: string };
};
/** Times are epoch milliseconds; null means not set. */
export type VacationSettings = {
  enableAutoReply: boolean;
  responseSubject: string;
  responseBodyPlainText: string;
  startTime: number | null;
  endTime: number | null;
};
export type GoogleAppCredentials = { clientId: string; clientSecret: string };
export interface GoogleClient {
  exchangeCode(args: GoogleAppCredentials & { code: string; redirectUri: string }): Promise<GoogleTokens>;
  refreshAccessToken(args: GoogleAppCredentials & { refreshToken: string }): Promise<{ accessToken: string; expiresInSeconds: number }>;
  revokeToken(args: { token: string }): Promise<void>;
  listCalendars(args: { accessToken: string }): Promise<GoogleCalendarEntry[]>;
  insertEvent(args: { accessToken: string; calendarId: string; event: GoogleEventInput }): Promise<{ id: string }>;
  deleteEvent(args: { accessToken: string; calendarId: string; eventId: string }): Promise<void>;
  getVacation(args: { accessToken: string }): Promise<VacationSettings>;
  setVacation(args: { accessToken: string; settings: VacationSettings }): Promise<void>;
}
export class GoogleApiError extends Error { readonly method: string; readonly status: number; readonly code: string }
export class RealGoogleClient implements GoogleClient { constructor(fetchFn?: typeof fetch) }
export class FakeGoogleClient implements GoogleClient { /* see Step 5 */ }
export function emailFromIdToken(idToken: string | null): string | null;
export const GOOGLE_TIMEOUT_MS = 8000;
```

- [ ] **Step 1: Write the failing tests for the real client**

Create `packages/core/src/google/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { emailFromIdToken, GoogleApiError, RealGoogleClient } from "./client";

type Call = [string, RequestInit];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function clientAnswering(...answers: Response[]) {
  const fetchFn = vi.fn(async () => answers.shift() ?? json({}, 500));
  const client = new RealGoogleClient(fetchFn as unknown as typeof fetch);
  const call = (n = 0) => fetchFn.mock.calls[n] as unknown as Call;
  return { client, call };
}

describe("RealGoogleClient", () => {
  it("exchanges a code for tokens", async () => {
    const { client, call } = clientAnswering(
      json({
        access_token: "ya29.a",
        expires_in: 3599,
        refresh_token: "1//r",
        scope: "openid email",
        id_token: "x.y.z",
      }),
    );
    const tokens = await client.exchangeCode({
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "the-code",
      redirectUri: "https://steward.example/oauth/google/callback",
    });
    expect(tokens).toEqual({
      accessToken: "ya29.a",
      expiresInSeconds: 3599,
      refreshToken: "1//r",
      scope: "openid email",
      idToken: "x.y.z",
    });
    const [url, init] = call();
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("redirect_uri")).toBe("https://steward.example/oauth/google/callback");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refreshes, and names Google's reason when the refresh token is no longer good", async () => {
    const { client, call } = clientAnswering(
      json({ access_token: "ya29.b", expires_in: 3600 }),
      json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400),
    );
    const creds = { clientId: "client-id", clientSecret: "client-secret", refreshToken: "1//r" };
    expect(await client.refreshAccessToken(creds)).toEqual({
      accessToken: "ya29.b",
      expiresInSeconds: 3600,
    });
    expect(new URLSearchParams(call()[1].body as string).get("grant_type")).toBe("refresh_token");
    const err = await client.refreshAccessToken(creds).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err).toMatchObject({ status: 400, code: "invalid_grant" });
    expect((err as Error).message).toBe("token.refresh: invalid_grant");
  });

  it("lists the calendars the person can write to", async () => {
    const { client, call } = clientAnswering(
      json({
        items: [
          { id: "dana@example.com", summary: "dana@example.com", primary: true },
          { id: "team@group.calendar.google.com", summary: "Team", summaryOverride: "Our team" },
        ],
      }),
    );
    expect(await client.listCalendars({ accessToken: "ya29.a" })).toEqual([
      { id: "dana@example.com", summary: "dana@example.com", primary: true },
      { id: "team@group.calendar.google.com", summary: "Our team", primary: false },
    ]);
    const [url, init] = call();
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer&maxResults=250",
    );
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ya29.a");
  });

  it("inserts an event and reports Google's reason on a refusal", async () => {
    const event = {
      id: "stwabc",
      summary: "Out of office",
      start: { date: "2026-11-12" },
      end: { date: "2026-11-18" },
      transparency: "opaque" as const,
    };
    const { client, call } = clientAnswering(
      json({ id: "stwabc" }),
      json({ error: { code: 409, status: "ALREADY_EXISTS", errors: [{ reason: "duplicate" }] } }, 409),
    );
    const args = { accessToken: "ya29.a", calendarId: "team@group.calendar.google.com", event };
    expect(await client.insertEvent(args)).toEqual({ id: "stwabc" });
    const [url, init] = call();
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(event);
    await expect(client.insertEvent(args)).rejects.toMatchObject({ status: 409, code: "duplicate" });
  });

  it("treats an event that is already gone as deleted", async () => {
    const { client, call } = clientAnswering(new Response(null, { status: 410 }));
    await client.deleteEvent({ accessToken: "ya29.a", calendarId: "primary", eventId: "stwabc" });
    expect(call()[0]).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/stwabc");
    expect(call()[1].method).toBe("DELETE");
  });

  it("reads and writes the Gmail auto-reply", async () => {
    const { client, call } = clientAnswering(
      json({
        enableAutoReply: true,
        responseSubject: "Away",
        responseBodyPlainText: "Back soon",
        startTime: "1000",
        endTime: "2000",
      }),
      json({}),
      json({}),
    );
    expect(await client.getVacation({ accessToken: "ya29.a" })).toEqual({
      enableAutoReply: true,
      responseSubject: "Away",
      responseBodyPlainText: "Back soon",
      startTime: 1000,
      endTime: 2000,
    });
    expect(call()[0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation");
    await client.setVacation({
      accessToken: "ya29.a",
      settings: {
        enableAutoReply: true,
        responseSubject: "Out of office",
        responseBodyPlainText: "Hello",
        startTime: 1000,
        endTime: 2000,
      },
    });
    expect(call(1)[1].method).toBe("PUT");
    expect(JSON.parse(call(1)[1].body as string)).toEqual({
      enableAutoReply: true,
      responseSubject: "Out of office",
      responseBodyPlainText: "Hello",
      restrictToContacts: false,
      restrictToDomain: false,
      startTime: "1000",
      endTime: "2000",
    });
    await client.setVacation({
      accessToken: "ya29.a",
      settings: {
        enableAutoReply: false,
        responseSubject: "",
        responseBodyPlainText: "",
        startTime: null,
        endTime: null,
      },
    });
    expect(JSON.parse(call(2)[1].body as string)).not.toHaveProperty("startTime");
  });

  it("gives an empty auto-reply when Gmail sends no fields", async () => {
    const { client } = clientAnswering(json({}));
    expect(await client.getVacation({ accessToken: "ya29.a" })).toEqual({
      enableAutoReply: false,
      responseSubject: "",
      responseBodyPlainText: "",
      startTime: null,
      endTime: null,
    });
  });

  it("revokes a token and does not mind one that is already revoked", async () => {
    const { client, call } = clientAnswering(json({ error: "invalid_token" }, 400));
    await client.revokeToken({ token: "1//r" });
    expect(call()[0]).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(call()[1].body as string).get("token")).toBe("1//r");
  });

  it("turns an answer that is not JSON into a typed error", async () => {
    const { client } = clientAnswering(new Response("<html>oops</html>", { status: 502 }));
    await expect(client.listCalendars({ accessToken: "ya29.a" })).rejects.toMatchObject({
      status: 502,
      code: "http_502",
    });
  });

  it("never calls fetch as a method of the client", async () => {
    const receivers: unknown[] = [];
    vi.stubGlobal("fetch", function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(json({ items: [] }));
    });
    try {
      await new RealGoogleClient().listCalendars({ accessToken: "ya29.a" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(receivers[0] === undefined || receivers[0] === globalThis).toBe(true);
  });
});

describe("emailFromIdToken", () => {
  const token = (claims: unknown) =>
    `h.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.s`;

  it("reads the email claim", () => {
    expect(emailFromIdToken(token({ email: "dana@example.com", sub: "1" }))).toBe(
      "dana@example.com",
    );
  });

  it("answers null for anything else", () => {
    expect(emailFromIdToken(null)).toBeNull();
    expect(emailFromIdToken("not-a-token")).toBeNull();
    expect(emailFromIdToken(token({ sub: "1" }))).toBeNull();
    expect(emailFromIdToken("h.@@@.s")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run packages/core/src/google/client.test.ts`
Expected: FAIL — `./client` does not exist.

- [ ] **Step 3: Write the real client**

Create `packages/core/src/google/client.ts`:

```ts
export type GoogleTokens = {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string | null;
  /** Granted scopes, separated by spaces. */
  scope: string;
  idToken: string | null;
};

export type GoogleCalendarEntry = { id: string; summary: string; primary: boolean };

export type GoogleEventTime = { dateTime: string } | { date: string };

export type GoogleEventInput = {
  /** Chosen by the caller: characters a–v and 0–9, 5 to 1024 long. A second insert with the same id answers 409. */
  id: string;
  summary: string;
  start: GoogleEventTime;
  end: GoogleEventTime;
  transparency: "opaque";
  eventType?: "outOfOffice";
  outOfOfficeProperties?: { autoDeclineMode: string; declineMessage: string };
};

/** Times are epoch milliseconds; null means not set. */
export type VacationSettings = {
  enableAutoReply: boolean;
  responseSubject: string;
  responseBodyPlainText: string;
  startTime: number | null;
  endTime: number | null;
};

export type GoogleAppCredentials = { clientId: string; clientSecret: string };

export interface GoogleClient {
  exchangeCode(
    args: GoogleAppCredentials & { code: string; redirectUri: string },
  ): Promise<GoogleTokens>;
  refreshAccessToken(
    args: GoogleAppCredentials & { refreshToken: string },
  ): Promise<{ accessToken: string; expiresInSeconds: number }>;
  /** Takes Steward's access away at Google. A token that is already revoked is not an error. */
  revokeToken(args: { token: string }): Promise<void>;
  /** The calendars the person can write to. */
  listCalendars(args: { accessToken: string }): Promise<GoogleCalendarEntry[]>;
  insertEvent(args: {
    accessToken: string;
    calendarId: string;
    event: GoogleEventInput;
  }): Promise<{ id: string }>;
  /** An event that is already gone is not an error. */
  deleteEvent(args: { accessToken: string; calendarId: string; eventId: string }): Promise<void>;
  getVacation(args: { accessToken: string }): Promise<VacationSettings>;
  setVacation(args: { accessToken: string; settings: VacationSettings }): Promise<void>;
}

/** `status` is the HTTP status; `code` is Google's own reason when it gave one, else `http_<status>`. */
export class GoogleApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(`${method}: ${code}`);
    this.name = "GoogleApiError";
  }
}

/** Every call to Google gives up after this long. */
export const GOOGLE_TIMEOUT_MS = 8000;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_URL = "https://www.googleapis.com/calendar/v3";
const VACATION_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

type ErrorBody = {
  error?: string | { status?: string; errors?: { reason?: string }[] };
};
type TokenBody = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
};
type VacationBody = {
  enableAutoReply?: boolean;
  responseSubject?: string;
  responseBodyPlainText?: string;
  startTime?: string;
  endTime?: string;
};

/** The token endpoint says `{ error: "invalid_grant" }`; the APIs say `{ error: { errors: [{ reason }] } }`. */
async function reasonOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ErrorBody;
    if (typeof body.error === "string") return body.error;
    return body.error?.errors?.[0]?.reason ?? body.error?.status ?? `http_${res.status}`;
  } catch {
    return `http_${res.status}`;
  }
}

const time = (value: string | undefined): number | null => {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) ? n : null;
};

/** The email claim of an ID token that came straight from Google's token endpoint over TLS (so it is not verified again here). */
export function emailFromIdToken(idToken: string | null): string | null {
  const part = idToken?.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as {
      email?: unknown;
    };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

export class RealGoogleClient implements GoogleClient {
  // The default is a wrapper, not `fetch` itself: Workers rejects the platform fetch when it is
  // called as a method of another object, which `this.fetchFn(...)` would be.
  constructor(private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init)) {}

  /** Sends one request; any status outside 2xx and `alsoFine` becomes a GoogleApiError. */
  private async send(
    method: string,
    url: string,
    init: RequestInit,
    alsoFine: number[] = [],
  ): Promise<Response> {
    const res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
    if (!res.ok && !alsoFine.includes(res.status)) {
      throw new GoogleApiError(method, res.status, await reasonOf(res));
    }
    return res;
  }

  private async body<T>(method: string, res: Response): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch {
      throw new GoogleApiError(method, res.status, `http_${res.status}`);
    }
  }

  private async token(method: string, form: Record<string, string>): Promise<TokenBody> {
    const res = await this.send(method, TOKEN_URL, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams(form).toString(),
    });
    const data = await this.body<TokenBody>(method, res);
    if (!data.access_token) throw new GoogleApiError(method, res.status, "no_access_token");
    return data;
  }

  private api(accessToken: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: unknown) {
    return {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  }

  async exchangeCode(
    args: GoogleAppCredentials & { code: string; redirectUri: string },
  ): Promise<GoogleTokens> {
    const data = await this.token("token.exchange", {
      grant_type: "authorization_code",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    });
    return {
      accessToken: data.access_token ?? "",
      expiresInSeconds: data.expires_in ?? 0,
      refreshToken: data.refresh_token ?? null,
      scope: data.scope ?? "",
      idToken: data.id_token ?? null,
    };
  }

  async refreshAccessToken(
    args: GoogleAppCredentials & { refreshToken: string },
  ): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const data = await this.token("token.refresh", {
      grant_type: "refresh_token",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
    });
    return { accessToken: data.access_token ?? "", expiresInSeconds: data.expires_in ?? 0 };
  }

  async revokeToken(args: { token: string }): Promise<void> {
    await this.send(
      "token.revoke",
      REVOKE_URL,
      { method: "POST", headers: FORM, body: new URLSearchParams({ token: args.token }).toString() },
      [400],
    );
  }

  async listCalendars(args: { accessToken: string }): Promise<GoogleCalendarEntry[]> {
    const method = "calendarList.list";
    const res = await this.send(
      method,
      `${CALENDAR_URL}/users/me/calendarList?minAccessRole=writer&maxResults=250`,
      this.api(args.accessToken, "GET"),
    );
    const data = await this.body<{
      items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean }[];
    }>(method, res);
    return (data.items ?? []).map((item) => ({
      id: item.id,
      summary: item.summaryOverride ?? item.summary ?? item.id,
      primary: item.primary === true,
    }));
  }

  async insertEvent(args: {
    accessToken: string;
    calendarId: string;
    event: GoogleEventInput;
  }): Promise<{ id: string }> {
    const method = "events.insert";
    const res = await this.send(
      method,
      `${CALENDAR_URL}/calendars/${encodeURIComponent(args.calendarId)}/events`,
      this.api(args.accessToken, "POST", args.event),
    );
    const data = await this.body<{ id?: string }>(method, res);
    return { id: data.id ?? args.event.id };
  }

  async deleteEvent(args: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<void> {
    await this.send(
      "events.delete",
      `${CALENDAR_URL}/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}`,
      this.api(args.accessToken, "DELETE"),
      [404, 410],
    );
  }

  async getVacation(args: { accessToken: string }): Promise<VacationSettings> {
    const method = "vacation.get";
    const res = await this.send(method, VACATION_URL, this.api(args.accessToken, "GET"));
    const data = await this.body<VacationBody>(method, res);
    return {
      enableAutoReply: data.enableAutoReply === true,
      responseSubject: data.responseSubject ?? "",
      responseBodyPlainText: data.responseBodyPlainText ?? "",
      startTime: time(data.startTime),
      endTime: time(data.endTime),
    };
  }

  async setVacation(args: { accessToken: string; settings: VacationSettings }): Promise<void> {
    const s = args.settings;
    await this.send(
      "vacation.update",
      VACATION_URL,
      this.api(args.accessToken, "PUT", {
        enableAutoReply: s.enableAutoReply,
        responseSubject: s.responseSubject,
        responseBodyPlainText: s.responseBodyPlainText,
        restrictToContacts: false,
        restrictToDomain: false,
        ...(s.startTime === null ? {} : { startTime: String(s.startTime) }),
        ...(s.endTime === null ? {} : { endTime: String(s.endTime) }),
      }),
    );
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run packages/core/src/google/client.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Write the fake and its test**

Create `packages/core/src/google/fake.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GoogleApiError } from "./client";
import { FakeGoogleClient } from "./fake";

const event = {
  id: "stwabc",
  summary: "Out of office",
  start: { date: "2026-11-12" },
  end: { date: "2026-11-18" },
  transparency: "opaque" as const,
};

describe("FakeGoogleClient", () => {
  it("holds events by calendar and id, and answers 409 for a second insert", async () => {
    const google = new FakeGoogleClient();
    await google.insertEvent({ accessToken: "t", calendarId: "c1", event });
    expect(google.events.get("c1/stwabc")).toEqual(event);
    await expect(
      google.insertEvent({ accessToken: "t", calendarId: "c1", event }),
    ).rejects.toMatchObject({ status: 409, code: "duplicate" });
    await google.deleteEvent({ accessToken: "t", calendarId: "c1", eventId: "stwabc" });
    await google.deleteEvent({ accessToken: "t", calendarId: "c1", eventId: "stwabc" });
    expect(google.events.size).toBe(0);
    expect(google.inserts).toHaveLength(1);
  });

  it("can refuse out-of-office events the way some accounts do", async () => {
    const google = new FakeGoogleClient();
    google.rejectOutOfOffice = true;
    const ooo = { ...event, eventType: "outOfOffice" as const };
    await expect(
      google.insertEvent({ accessToken: "t", calendarId: "c1", event: ooo }),
    ).rejects.toMatchObject({ status: 400 });
    await google.insertEvent({ accessToken: "t", calendarId: "c1", event });
    expect(google.events.size).toBe(1);
  });

  it("fails the next call to a method once, then works", async () => {
    const google = new FakeGoogleClient();
    google.failNext.getVacation = { status: 500, code: "backendError" };
    await expect(google.getVacation({ accessToken: "t" })).rejects.toBeInstanceOf(GoogleApiError);
    expect((await google.getVacation({ accessToken: "t" })).enableAutoReply).toBe(false);
  });

  it("records token calls and keeps the auto-reply it was given", async () => {
    const google = new FakeGoogleClient();
    const creds = { clientId: "client-id", clientSecret: "client-secret" };
    expect((await google.exchangeCode({ ...creds, code: "c", redirectUri: "u" })).refreshToken).toBe(
      "1//refresh",
    );
    expect((await google.refreshAccessToken({ ...creds, refreshToken: "1//refresh" })).accessToken).toBe(
      "ya29.fresh",
    );
    await google.revokeToken({ token: "1//refresh" });
    expect(google.exchangedCodes).toEqual(["c"]);
    expect(google.refreshes).toEqual(["1//refresh"]);
    expect(google.revoked).toEqual(["1//refresh"]);
    const settings = {
      enableAutoReply: true,
      responseSubject: "Out of office",
      responseBodyPlainText: "Hello",
      startTime: 1,
      endTime: 2,
    };
    await google.setVacation({ accessToken: "t", settings });
    expect(await google.getVacation({ accessToken: "t" })).toEqual(settings);
  });
});
```

Create `packages/core/src/google/fake.ts`:

```ts
import {
  type GoogleAppCredentials,
  GoogleApiError,
  type GoogleCalendarEntry,
  type GoogleClient,
  type GoogleEventInput,
  type GoogleTokens,
  type VacationSettings,
} from "./client";

const OFF: VacationSettings = {
  enableAutoReply: false,
  responseSubject: "",
  responseBodyPlainText: "",
  startTime: null,
  endTime: null,
};

/** In-memory Google: one account's calendars, events and auto-reply, with every call recorded. */
export class FakeGoogleClient implements GoogleClient {
  /** What `exchangeCode` answers. Set `refreshToken` to null to act like a consent that gave no refresh token. */
  tokens: GoogleTokens = {
    accessToken: "ya29.access",
    expiresInSeconds: 3600,
    refreshToken: "1//refresh",
    scope: "",
    idToken: null,
  };
  calendars: GoogleCalendarEntry[] = [{ id: "dana@example.com", summary: "Dana", primary: true }];
  /** Keyed `<calendarId>/<eventId>`. */
  events = new Map<string, GoogleEventInput>();
  vacation: VacationSettings = { ...OFF };
  /** True makes every `outOfOffice` insert answer 400, like an account type that does not have them. */
  rejectOutOfOffice = false;
  exchangedCodes: string[] = [];
  refreshes: string[] = [];
  revoked: string[] = [];
  inserts: { calendarId: string; event: GoogleEventInput }[] = [];
  /** Set a method name to make its next call fail once with that status and reason. */
  failNext: Partial<Record<keyof GoogleClient, { status: number; code: string }>> = {};

  private maybeFail(method: keyof GoogleClient): void {
    const failure = this.failNext[method];
    if (failure) {
      delete this.failNext[method];
      throw new GoogleApiError(method, failure.status, failure.code);
    }
  }

  async exchangeCode(
    args: GoogleAppCredentials & { code: string; redirectUri: string },
  ): Promise<GoogleTokens> {
    this.maybeFail("exchangeCode");
    this.exchangedCodes.push(args.code);
    return this.tokens;
  }

  async refreshAccessToken(
    args: GoogleAppCredentials & { refreshToken: string },
  ): Promise<{ accessToken: string; expiresInSeconds: number }> {
    this.maybeFail("refreshAccessToken");
    this.refreshes.push(args.refreshToken);
    return { accessToken: "ya29.fresh", expiresInSeconds: 3600 };
  }

  async revokeToken(args: { token: string }): Promise<void> {
    this.maybeFail("revokeToken");
    this.revoked.push(args.token);
  }

  async listCalendars(_args: { accessToken: string }): Promise<GoogleCalendarEntry[]> {
    this.maybeFail("listCalendars");
    return this.calendars;
  }

  async insertEvent(args: {
    accessToken: string;
    calendarId: string;
    event: GoogleEventInput;
  }): Promise<{ id: string }> {
    this.maybeFail("insertEvent");
    if (this.rejectOutOfOffice && args.event.eventType === "outOfOffice") {
      throw new GoogleApiError("insertEvent", 400, "invalid");
    }
    const key = `${args.calendarId}/${args.event.id}`;
    if (this.events.has(key)) throw new GoogleApiError("insertEvent", 409, "duplicate");
    this.events.set(key, args.event);
    this.inserts.push({ calendarId: args.calendarId, event: args.event });
    return { id: args.event.id };
  }

  async deleteEvent(args: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<void> {
    this.maybeFail("deleteEvent");
    this.events.delete(`${args.calendarId}/${args.eventId}`);
  }

  async getVacation(_args: { accessToken: string }): Promise<VacationSettings> {
    this.maybeFail("getVacation");
    return { ...this.vacation };
  }

  async setVacation(args: { accessToken: string; settings: VacationSettings }): Promise<void> {
    this.maybeFail("setVacation");
    this.vacation = { ...args.settings };
  }
}
```

- [ ] **Step 6: Export from the package**

In `packages/core/src/index.ts` add:

```ts
export type {
  GoogleAppCredentials,
  GoogleCalendarEntry,
  GoogleClient,
  GoogleEventInput,
  GoogleEventTime,
  GoogleTokens,
  VacationSettings,
} from "./google/client";
export {
  emailFromIdToken,
  GOOGLE_TIMEOUT_MS,
  GoogleApiError,
  RealGoogleClient,
} from "./google/client";
export { FakeGoogleClient } from "./google/fake";
```

Run `pnpm exec biome check --write packages/core/src/index.ts` to place the block in order.

- [ ] **Step 7: Run the tests and commit**

Run: `pnpm exec vitest run packages/core/src/google`
Expected: PASS (16 tests).

```bash
pnpm test && pnpm typecheck && pnpm lint
git add packages/core
git commit -m "feat(core): a Google client for tokens, calendars, events and the Gmail auto-reply, with a fake

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Tasks 3 to 11: design agreed, steps still to be written out

> **Not ready to execute.** Tasks 1 and 2 above are complete. The tasks below are the settled design; each still needs its steps (failing test, code, commands, commit) written in the same format before an implementer starts.

### Task 3: Token source (`packages/core/src/google/tokens.ts`)

- `class GoogleTokenSource` built from `{ db, google: GoogleClient, tokenKey, clientId, clientSecret, now }`.
- `accessFor(personId)` answers `{ ok: true, accessToken, connection }` or `{ ok: false, reason: "not_connected" | "reconnect" }`.
- No row → `not_connected`. Health `revoked` → `reconnect`.
- Sealed access token with more than 60 seconds left → open it and use it. Otherwise `refreshAccessToken`, seal and store with `setGoogleAccessToken`.
- Refresh fails with `invalid_grant` → `setGoogleHealth(..., "revoked")` and answer `reconnect`. Any other failure is thrown (the write fails and is retried).
- `expire(personId)` clears the stored access token (used after a 401).
- Tests use `FakeGoogleClient` and `seedGoogleConnection`.

### Task 4: Plan, templates, save, card, form

- `plan.ts`: `GOOGLE_CALENDAR = "google-calendar"`, `GMAIL_RESPONDER = "gmail-responder"`, `GOOGLE_TYPES = ["out", "sick"]`, `writesAtSave(system)` (true for the two Google systems). `planWrites(input, times, google)` where `google` is `null` or `{ calendars: GoogleCalendar[] }`: Slack always; for a Google type with a connection, one `google-calendar` write (args: `from`, `to`, `tz`, `summary`, chosen calendar ids) and one `gmail-responder` write (args: subject, body, `startMs`, `endMs`).
- `templates.ts`: the auto-reply subject and body per type, with the dates filled in.
- `engine.ts`: `createTargets(db, statusId, specs, recoverAt)` where `recoverAt` is a number, `null` or `(spec) => number | null`.
- `service.ts` `saveStatus`: reads the Google connection; creates all targets; runs save-time targets at once, also for a scheduled status; runs the rest only when the status is active. `SaveResult` gains `notes: string[]` (the "run /ooo google" hint for a Google type with no connection).
- `card.ts`: names "Calendar event" and "Gmail auto-reply"; lines in the order Slack, Calendar, Gmail; done wording for Google lines says the days; notes shown as a context line.
- `form.ts`: `MAX_LAST_DAY_AHEAD = 730`, error "Pick a last day within the next two years."

### Task 5: Calendar connector (`connectors/googleCalendar.ts`)

- Event id: `stw` + hex SHA-256 of the idempotency key.
- Main calendar: timed `outOfOffice` event, first midnight to the midnight after the last day in the person's time zone, `autoDeclineMode: "declineOnlyNewConflictingInvitations"`. On 400 or 403, an ordinary all-day busy event instead.
- Other chosen calendars: the all-day event.
- 409 counts as done. 401 → `tokens.expire(personId)` and throw again so the retry refreshes.
- `not_connected` / `reconnect` / missing scope → `SkipWrite("Reconnect Google — run /ooo google")`.
- Undo deletes the event on every chosen calendar; 404 and 410 count as gone.

### Task 6: Gmail connector (`connectors/gmailResponder.ts`) and `connectors/googleAccess.ts`

- `googleAccess.ts`: one helper both connectors use to get a token or throw `SkipWrite`.
- Read the auto-reply first. If one is on, has not ended, and is not word for word Steward's: `SkipWrite("your Gmail auto-reply is already on — Steward left it alone")`.
- Otherwise set it with start and end times.
- Undo: read; turn off only if it is still the one Steward set.

### Task 7: Worker wiring

- `Env`: optional `GOOGLE_CLIENT_ID?`, `GOOGLE_CLIENT_SECRET?`. `Deps`: `google: GoogleClient`, `googleClientId: string | null`, `googleClientSecret: string | null`.
- Test helpers: `FakeGoogleClient`, ids `"google-client-id"` / `"google-client-secret"`. `.dev.vars.example` gains the two names.
- New `apps/worker/src/registry.ts`: `registryFor(deps)` registers Slack and, when the Google ids are set, the two Google connectors. `handlers.ts` and `tick.ts` both use it.
- The demo keeps working unchanged (demo people have no connection).

### Task 8: Connect routes

- `apps/worker/src/google/state.ts`: `signGoogleState(secret, personId, issuedAtSeconds)` / `verifyGoogleState(...)`, purpose prefix `google:`, good for 600 seconds, compared with `timingSafeEqual`.
- `routes/google.ts`, mounted at `/oauth/google` before `/oauth`:
  - `GET /start?state=…`: a page naming the Slack person and workspace, with a Continue link to Google (`access_type=offline`, `prompt=consent`, the spec's scopes).
  - `GET /callback`: verify state, exchange the code, list calendars, seal tokens, `upsertGoogleConnection` (main calendar chosen), answer a plain "connected" page. No refresh token → say so and ask to try again.
- 503 with plain words when the Google ids are not set.

### Task 9: `/ooo google` and `/ooo google disconnect`

- `slack/googleCommand.ts`; `handleSlashCommand` reads `form.get("text")`.
- `google`: answers privately with the connect link (or "already connected as …" plus how to disconnect).
- `google disconnect`: revoke the refresh token at Google (best effort), delete the row, confirm.
- Manifest: `usage_hint` for `/ooo`.

### Task 10: Tick

- `startDue` runs only the targets that are not save-time ones.
- `retryDue` also picks up save-time targets of scheduled statuses.
- Retry budget 2 per tick: a Slack retry weighs 1, a Google retry weighs 2; the first due write always runs. The worst case stays 44 statements and 7 outbound calls; `demo.d1.smoke.test.ts` bounds must still pass unchanged.
- Existing Slack messages stay word for word. Google wording ends "Set it by hand, or run /ooo again."

### Task 11: README and hand checks

- README: what is true now, the two secrets, the Google Cloud setup steps.
- Hand checks: connect; out today; out next week (event and auto-reply appear at save); undo; existing auto-reply left alone; disconnect.

## After the last task (the owner does these)

1. Apply migration 0007 to the live database by hand, before the merge.
2. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` with `wrangler secret put`.
3. Run the hand checks.

## Not in this plan

- A screen for choosing calendars; cover person in the auto-reply; Google in the demo; "Delete my data"; finding a time for a group.
- Known limits to tell the owner: while the Google app is in "Testing", connections end after 7 days; `gmail.settings.basic` is a restricted scope and needs Google's security assessment before public sale.
