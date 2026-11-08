# Steward · Plan 1: Core and the First Door — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker that a Slack workspace can install, where `/ooo` opens a status form, saving it sets the person's Slack status through the act-with-receipt engine, and the receipt card offers a working Undo — all driven by tests against a fake Slack client.

**Architecture:** A pnpm monorepo: `packages/core` (Slack HTTP surface, Slack client with real and fake implementations, AES-GCM token sealing, Drizzle schema on SQLite/D1, the act-with-receipt engine), `packages/availability` (status types, the modal form, write planning, the result card, save/undo service, the Slack-status connector), `apps/worker` (one Hono app on Cloudflare Workers with `/slack/*`, `/oauth/slack/*`, `/health`, a minute cron tick). Tests run on Node with an in-memory SQLite database and the fake Slack client; production uses D1 and the real client. Every write is a target row with an explicit state; the receipt is rendered from those rows.

**Tech Stack:** TypeScript 5, pnpm, Hono 4, Drizzle ORM (sqlite-core; `drizzle-orm/d1` in production, `drizzle-orm/better-sqlite3` in tests), drizzle-kit, Vitest 3, Biome 2, Wrangler 4, WebCrypto (HMAC-SHA256, AES-GCM).

## Global Constraints

- TypeScript end to end; Node `>=22`; ESM everywhere (`"type": "module"`).
- Runs on Cloudflare Workers with `compatibility_flags = ["nodejs_compat"]`; database is D1 via Drizzle; free tiers only.
- Slack in **HTTP mode**: Slack calls our URLs; every `/slack/*` request is signature-verified before anything else.
- Principles from the spec apply to every task: parse then review; act only on a yes; receipts and Undo (five minutes); honest states (`pending`, `done`, `failed`, `skipped`, `undone` are distinct and worded plainly); one save path.
- Tokens are never stored in clear: AES-GCM under the `TOKEN_KEY` secret.
- Nothing from any employer — no company names, org vocabulary or people — in code, comments, fixtures or docs. Sample names in tests are fictional (Dana, Omer, Noa).
- Commits: conventional prefixes (`feat:`, `test:`, `chore:`, `docs:`), one commit per task, each ending with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Licence header is not required per file; `LICENSE` (BSL 1.1) covers the repo.
- Run everything from the repo root `C:\Users\nafta\steward` unless a step says otherwise.

---

## File structure

```
steward/
  package.json                       root scripts: lint, typecheck, test
  pnpm-workspace.yaml
  tsconfig.base.json                 strict compiler options + @steward/* path aliases
  biome.json
  vitest.config.ts                   test discovery + aliases
  .node-version                      22
  .github/workflows/ci.yml           lint → typecheck → test → wrangler dry-run build
  packages/core/
    package.json                     @steward/core (exports ".", "./testing")
    tsconfig.json                    node types
    drizzle.config.ts                drizzle-kit: sqlite, schema → ./drizzle
    drizzle/                         generated SQL migrations (committed)
    src/index.ts                     public exports
    src/testing.ts                   createTestDb() — Node-only
    src/ids.ts                       newId()
    src/slack/verify.ts              slackSignature(), verifySlackSignature()
    src/slack/blocks.ts              Block Kit types + builders
    src/slack/client.ts              SlackClient interface, RealSlackClient, SlackApiError
    src/slack/fake.ts                FakeSlackClient
    src/crypto/seal.ts               seal(), open(), newKeyB64()
    src/db/schema.ts                 workspaces, people, statuses, status_targets, audit
    src/db/client.ts                 Db type
    src/db/repo.ts                   getWorkspace, upsertWorkspace, ensurePerson, setPersonUserToken
    src/engine/connector.ts          WriteSpec, ConnectorCtx, Connector, ConnectorRegistry, SkipWrite
    src/engine/engine.ts             createTargets, executeTargets, undoTargets
  packages/availability/
    package.json                     @steward/availability
    tsconfig.json
    src/index.ts
    src/status/types.ts              STATUS_TYPES, labels, defaults, StatusInput
    src/status/time.ts               zonedTimeToEpochMs, todayIn, nextDay, formatRange
    src/status/form.ts               buildStatusModal, readStatusSubmission
    src/status/plan.ts               planWrites
    src/status/card.ts               resultCard, UNDO_ACTION
    src/status/service.ts            saveStatus, undoStatus
    src/connectors/slackStatus.ts    SlackStatusConnector
  apps/worker/
    package.json                     @steward/worker
    tsconfig.json                    workers types
    wrangler.toml
    .dev.vars.example
    src/env.ts                       Env
    src/deps.ts                      Deps, depsFromEnv
    src/db.ts                        createD1Db
    src/slackTypes.ts                interaction payload types
    src/routes/slack.ts              /slack/commands, /slack/interactions
    src/routes/oauth.ts              /oauth/slack/install, /oauth/slack/callback
    src/app.ts                       createApp(deps)
    src/tick.ts                      runTick
    src/index.ts                     fetch + scheduled handlers
    test/helpers.ts                  signed Slack requests, seeded db
    test/ooo.test.ts                 the /ooo flow end to end
    test/oauth.test.ts               install flow
    test/tick.test.ts
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `.node-version`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: path aliases `@steward/core`, `@steward/core/testing`, `@steward/availability` used by every later task; root scripts `pnpm lint`, `pnpm typecheck`, `pnpm test`.

- [ ] **Step 1: Root manifests**

`package.json`:
```json
{
  "name": "steward",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.12.1",
  "engines": { "node": ">=22" },
  "scripts": {
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "typecheck": "tsc --noEmit -p packages/core && tsc --noEmit -p packages/availability && tsc --noEmit -p apps/worker",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.2.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`.node-version`:
```
22
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM"],
    "paths": {
      "@steward/core": ["./packages/core/src/index.ts"],
      "@steward/core/testing": ["./packages/core/src/testing.ts"],
      "@steward/availability": ["./packages/availability/src/index.ts"]
    }
  }
}
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.2.0/schema.json",
  "files": { "includes": ["**", "!**/dist", "!**/.wrangler", "!**/drizzle/meta"] },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } }
}
```

`vitest.config.ts`:
```ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@steward/core/testing": path.resolve(__dirname, "packages/core/src/testing.ts"),
      "@steward/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@steward/availability": path.resolve(__dirname, "packages/availability/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: The core package shell**

`packages/core/package.json`:
```json
{
  "name": "@steward/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "drizzle-orm": "^0.44.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "better-sqlite3": "^12.0.0",
    "drizzle-kit": "^0.31.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src"]
}
```

`packages/core/src/index.ts`:
```ts
export const CORE_VERSION = "0.0.0";
```

- [ ] **Step 3: CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```
(The Worker dry-run build is added to this file in Task 10.)

- [ ] **Step 4: Install and verify**

Run: `pnpm install`
Expected: a `pnpm-lock.yaml` appears; no errors.

Run: `pnpm lint && pnpm exec tsc --noEmit -p packages/core && pnpm exec vitest run --passWithNoTests`
Expected: Biome reports no errors; tsc prints nothing; Vitest prints "No test files found" and exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: monorepo scaffold (pnpm, TypeScript, Biome, Vitest, CI)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Slack request signature verification

**Files:**
- Create: `packages/core/src/slack/verify.ts`
- Test: `packages/core/src/slack/verify.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `slackSignature(secret: string, timestamp: string, body: string): Promise<string>` (returns `v0=<hex>`); `verifySlackSignature(args: { secret: string; timestamp: string; body: string; signature: string; nowSeconds: number }): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/slack/verify.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { slackSignature, verifySlackSignature } from "./verify";

const secret = "8f742231b10e8888abcd99yyyzzz85a5";
const timestamp = "1531420618";
const body =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";

describe("slackSignature", () => {
  it("matches the worked example from Slack's 'Verifying requests' documentation", async () => {
    // If this vector ever fails, check the documentation page, not the implementation.
    expect(await slackSignature(secret, timestamp, body)).toBe(
      "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
    );
  });
});

describe("verifySlackSignature", () => {
  const now = Number(timestamp) + 10;

  it("accepts a correct signature within the five-minute window", async () => {
    const signature = await slackSignature(secret, timestamp, body);
    expect(await verifySlackSignature({ secret, timestamp, body, signature, nowSeconds: now })).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await slackSignature(secret, timestamp, body);
    expect(
      await verifySlackSignature({ secret, timestamp, body: `${body}&x=1`, signature, nowSeconds: now }),
    ).toBe(false);
  });

  it("rejects a stale timestamp", async () => {
    const signature = await slackSignature(secret, timestamp, body);
    expect(
      await verifySlackSignature({ secret, timestamp, body, signature, nowSeconds: now + 600 }),
    ).toBe(false);
  });

  it("rejects a malformed timestamp and a wrong-length signature", async () => {
    expect(
      await verifySlackSignature({ secret, timestamp: "abc", body, signature: "v0=00", nowSeconds: now }),
    ).toBe(false);
    expect(
      await verifySlackSignature({ secret, timestamp, body, signature: "v0=00", nowSeconds: now }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/core/src/slack/verify.test.ts`
Expected: FAIL — `Failed to resolve import "./verify"`.

- [ ] **Step 3: Implement**

`packages/core/src/slack/verify.ts`:
```ts
const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison; false for different lengths. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function slackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  return `v0=${toHex(mac)}`;
}

const MAX_SKEW_SECONDS = 300;

export async function verifySlackSignature(args: {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
  nowSeconds: number;
}): Promise<boolean> {
  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts) || Math.abs(args.nowSeconds - ts) > MAX_SKEW_SECONDS) return false;
  const expected = await slackSignature(args.secret, args.timestamp, args.body);
  return timingSafeEqual(expected, args.signature);
}
```

Replace `packages/core/src/index.ts` with:
```ts
export { slackSignature, timingSafeEqual, verifySlackSignature } from "./slack/verify";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run packages/core/src/slack/verify.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): verify Slack request signatures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Token sealing (AES-GCM)

**Files:**
- Create: `packages/core/src/crypto/seal.ts`
- Test: `packages/core/src/crypto/seal.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `seal(keyB64: string, plaintext: string): Promise<string>`, `open(keyB64: string, sealed: string): Promise<string>`, `newKeyB64(): string` (32 random bytes, base64). Sealed format: base64 of `iv(12 bytes) || ciphertext`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/crypto/seal.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newKeyB64, open, seal } from "./seal";

describe("seal/open", () => {
  it("round-trips a token and never stores it in clear", async () => {
    const key = newKeyB64();
    const sealed = await seal(key, "xoxb-secret-token");
    expect(sealed).not.toContain("xoxb");
    expect(await open(key, sealed)).toBe("xoxb-secret-token");
  });

  it("produces a different ciphertext each time (random IV)", async () => {
    const key = newKeyB64();
    expect(await seal(key, "same")).not.toBe(await seal(key, "same"));
  });

  it("fails to open with another key", async () => {
    const sealed = await seal(newKeyB64(), "secret");
    await expect(open(newKeyB64(), sealed)).rejects.toThrow();
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(seal(btoa("short"), "x")).rejects.toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/core/src/crypto/seal.test.ts`
Expected: FAIL — `Failed to resolve import "./seal"`.

- [ ] **Step 3: Implement**

`packages/core/src/crypto/seal.ts`:
```ts
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const IV_BYTES = 12;

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function importKey(keyB64: string, usage: KeyUsage): Promise<CryptoKey> {
  const raw = b64decode(keyB64);
  if (raw.byteLength !== 32) throw new Error("TOKEN_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

export function newKeyB64(): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function seal(keyB64: string, plaintext: string): Promise<string> {
  const key = await importKey(keyB64, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return b64encode(out);
}

export async function open(keyB64: string, sealed: string): Promise<string> {
  const key = await importKey(keyB64, "decrypt");
  const bytes = b64decode(sealed);
  const iv = bytes.slice(0, IV_BYTES);
  const ciphertext = bytes.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return decoder.decode(plaintext);
}
```

Add to `packages/core/src/index.ts`:
```ts
export { newKeyB64, open, seal } from "./crypto/seal";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run packages/core/src/crypto/seal.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): seal and open tokens with AES-GCM

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Database schema, migrations and the test database

**Files:**
- Create: `packages/core/drizzle.config.ts`, `packages/core/src/db/schema.ts`, `packages/core/src/db/client.ts`, `packages/core/src/db/repo.ts`, `packages/core/src/testing.ts`, `packages/core/src/ids.ts`
- Create (generated): `packages/core/drizzle/0000_*.sql`, `packages/core/drizzle/meta/*`
- Test: `packages/core/src/db/repo.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `Db` type; tables `workspaces`, `people`, `statuses`, `statusTargets`, `audit` with the columns below; `createTestDb(): Db`; `newId(): string`; `getWorkspace(db, id)`, `upsertWorkspace(db, row)`, `ensurePerson(db, workspaceId, slackUserId, displayName)`, `getPerson(db, id)`, `setPersonUserToken(db, personId, sealed)`, `personId(workspaceId, slackUserId)`.
- Row types: `WorkspaceRow = typeof workspaces.$inferSelect`, `PersonRow = typeof people.$inferSelect`, `StatusRow = typeof statuses.$inferSelect`, `TargetRow = typeof statusTargets.$inferSelect`.

- [ ] **Step 1: Schema**

`packages/core/src/db/schema.ts`:
```ts
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One row per installed Slack workspace (a tenant). `id` is Slack's team id. */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  botTokenSealed: text("bot_token_sealed").notNull(),
  botUserId: text("bot_user_id").notNull(),
  installedAt: integer("installed_at").notNull(),
});

/** One row per person per workspace. `id` is `${workspaceId}:${slackUserId}`. */
export const people = sqliteTable(
  "people",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    displayName: text("display_name").notNull(),
    tz: text("tz").notNull().default("UTC"),
    userTokenSealed: text("user_token_sealed"),
  },
  (t) => [index("people_workspace_idx").on(t.workspaceId)],
);

export const statuses = sqliteTable(
  "statuses",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    personId: text("person_id").notNull(),
    type: text("type").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    text: text("text").notNull(),
    emoji: text("emoji").notNull(),
    /** scheduled | active | ended | cancelled */
    state: text("state").notNull(),
    /** form | words | quick | rule | capture */
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
    undoUntilMs: integer("undo_until_ms"),
    replacedStatusId: text("replaced_status_id"),
  },
  (t) => [index("statuses_person_state_idx").on(t.personId, t.state)],
);

/** One row per (status, system write). The receipt card is rendered from these rows. */
export const statusTargets = sqliteTable(
  "status_targets",
  {
    id: text("id").primaryKey(),
    statusId: text("status_id").notNull(),
    system: text("system").notNull(),
    op: text("op").notNull(),
    /** JSON of the WriteSpec, so execute and undo can be replayed from the row. */
    spec: text("spec").notNull(),
    /** pending | done | failed | skipped | undone */
    state: text("state").notNull(),
    externalId: text("external_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
  },
  (t) => [index("status_targets_status_idx").on(t.statusId)],
);

export const audit = sqliteTable("audit", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  personId: text("person_id").notNull(),
  action: text("action").notNull(),
  result: text("result").notNull(),
  detail: text("detail"),
  at: integer("at").notNull(),
  idempotencyKey: text("idempotency_key"),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type PersonRow = typeof people.$inferSelect;
export type StatusRow = typeof statuses.$inferSelect;
export type TargetRow = typeof statusTargets.$inferSelect;
```

`packages/core/src/db/client.ts`:
```ts
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";

/** Works for both the D1 driver (async) and the better-sqlite3 driver used in tests (sync). */
export type Db = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;
```

`packages/core/src/ids.ts`:
```ts
export function newId(): string {
  return crypto.randomUUID();
}
```

`packages/core/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

- [ ] **Step 2: Generate the first migration**

Run: `pnpm --filter @steward/core db:generate`
Expected: `packages/core/drizzle/0000_<name>.sql` and `packages/core/drizzle/meta/` created; the SQL contains `CREATE TABLE \`workspaces\``, `people`, `statuses`, `status_targets`, `audit`.

- [ ] **Step 3: Test database and the failing repo tests**

`packages/core/src/testing.ts`:
```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./db/client";
import * as schema from "./db/schema";

/** An in-memory SQLite database with all migrations applied. Node only. */
export function createTestDb(): Db {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  const here = path.dirname(fileURLToPath(import.meta.url));
  migrate(db, { migrationsFolder: path.join(here, "../drizzle") });
  return db as unknown as Db;
}
```

`packages/core/src/db/repo.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../testing";
import type { Db } from "./client";
import { ensurePerson, getWorkspace, setPersonUserToken, upsertWorkspace } from "./repo";

describe("repo", () => {
  let db: Db;
  beforeEach(() => {
    db = createTestDb();
  });

  it("upserts a workspace and reads it back", async () => {
    await upsertWorkspace(db, {
      id: "T1",
      name: "Acme",
      botTokenSealed: "sealed-bot",
      botUserId: "UBOT",
      installedAt: 1_000,
    });
    await upsertWorkspace(db, {
      id: "T1",
      name: "Acme Renamed",
      botTokenSealed: "sealed-bot-2",
      botUserId: "UBOT",
      installedAt: 2_000,
    });
    const ws = await getWorkspace(db, "T1");
    expect(ws?.name).toBe("Acme Renamed");
    expect(ws?.botTokenSealed).toBe("sealed-bot-2");
    expect(await getWorkspace(db, "T2")).toBeNull();
  });

  it("ensurePerson creates once and returns the same row afterwards", async () => {
    const first = await ensurePerson(db, "T1", "U1", "Dana");
    const again = await ensurePerson(db, "T1", "U1", "Dana (renamed)");
    expect(first.id).toBe("T1:U1");
    expect(again.id).toBe(first.id);
    expect(again.displayName).toBe("Dana");
    expect(again.tz).toBe("UTC");
    expect(again.userTokenSealed).toBeNull();
  });

  it("stores a sealed user token", async () => {
    const person = await ensurePerson(db, "T1", "U1", "Dana");
    const updated = await setPersonUserToken(db, person.id, "sealed-user");
    expect(updated.userTokenSealed).toBe("sealed-user");
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm exec vitest run packages/core/src/db/repo.test.ts`
Expected: FAIL — `Failed to resolve import "./repo"`.

- [ ] **Step 5: Implement the repo**

`packages/core/src/db/repo.ts`:
```ts
import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { type PersonRow, type WorkspaceRow, people, workspaces } from "./schema";

export async function getWorkspace(db: Db, id: string): Promise<WorkspaceRow | null> {
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, id));
  return rows[0] ?? null;
}

export async function upsertWorkspace(db: Db, row: WorkspaceRow): Promise<void> {
  await db
    .insert(workspaces)
    .values(row)
    .onConflictDoUpdate({
      target: workspaces.id,
      set: {
        name: row.name,
        botTokenSealed: row.botTokenSealed,
        botUserId: row.botUserId,
        installedAt: row.installedAt,
      },
    });
}

export function personId(workspaceId: string, slackUserId: string): string {
  return `${workspaceId}:${slackUserId}`;
}

export async function getPerson(db: Db, id: string): Promise<PersonRow | null> {
  const rows = await db.select().from(people).where(eq(people.id, id));
  return rows[0] ?? null;
}

export async function ensurePerson(
  db: Db,
  workspaceId: string,
  slackUserId: string,
  displayName: string,
): Promise<PersonRow> {
  const id = personId(workspaceId, slackUserId);
  const existing = await getPerson(db, id);
  if (existing) return existing;
  const row: PersonRow = {
    id,
    workspaceId,
    slackUserId,
    displayName,
    tz: "UTC",
    userTokenSealed: null,
  };
  await db.insert(people).values(row);
  return row;
}

export async function setPersonUserToken(db: Db, id: string, sealed: string): Promise<PersonRow> {
  await db.update(people).set({ userTokenSealed: sealed }).where(eq(people.id, id));
  const row = await getPerson(db, id);
  if (!row) throw new Error(`person ${id} not found`);
  return row;
}
```

Add to `packages/core/src/index.ts`:
```ts
export type { Db } from "./db/client";
export {
  ensurePerson,
  getPerson,
  getWorkspace,
  personId,
  setPersonUserToken,
  upsertWorkspace,
} from "./db/repo";
export * as schema from "./db/schema";
export type { PersonRow, StatusRow, TargetRow, WorkspaceRow } from "./db/schema";
export { newId } from "./ids";
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm exec vitest run packages/core/src/db/repo.test.ts`
Expected: 3 tests PASS. (If `better-sqlite3` reports a missing binary, run `pnpm rebuild better-sqlite3` once.)

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): database schema, first migration, test database and repo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Block Kit builders and the Slack client (real and fake)

**Files:**
- Create: `packages/core/src/slack/blocks.ts`, `packages/core/src/slack/client.ts`, `packages/core/src/slack/fake.ts`
- Test: `packages/core/src/slack/client.test.ts`, `packages/core/src/slack/fake.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: Block Kit types (`Block`, `ModalView`, `Element`, `Option`, …) and builders `plain`, `mrkdwn`, `header`, `section`, `context`, `divider`, `actions`, `button`, `option`, `input`, `staticSelect`, `datepicker`, `textInput`; `SlackClient` interface with `openView`, `respond`, `setUserStatus`, `clearUserStatus`; `RealSlackClient(fetchFn)`; `FakeSlackClient` recording `openedViews`, `responses`, `statuses` with `failNext`; `SlackApiError(method, code)`.

- [ ] **Step 1: Block Kit types and builders**

`packages/core/src/slack/blocks.ts`:
```ts
export type PlainText = { type: "plain_text"; text: string; emoji?: boolean };
export type Mrkdwn = { type: "mrkdwn"; text: string };
export type TextObject = PlainText | Mrkdwn;
export type Option = { text: PlainText; value: string };

export type Button = {
  type: "button";
  text: PlainText;
  action_id: string;
  value?: string;
  url?: string;
  style?: "primary" | "danger";
};
export type StaticSelect = {
  type: "static_select";
  action_id: string;
  options: Option[];
  initial_option?: Option;
  placeholder?: PlainText;
};
export type Datepicker = { type: "datepicker"; action_id: string; initial_date?: string };
export type PlainTextInput = {
  type: "plain_text_input";
  action_id: string;
  initial_value?: string;
  placeholder?: PlainText;
  multiline?: boolean;
};
export type Element = Button | StaticSelect | Datepicker | PlainTextInput;

export type HeaderBlock = { type: "header"; text: PlainText };
export type SectionBlock = {
  type: "section";
  text?: TextObject;
  fields?: TextObject[];
  accessory?: Element;
  block_id?: string;
};
export type ActionsBlock = { type: "actions"; elements: Element[]; block_id?: string };
export type ContextBlock = { type: "context"; elements: TextObject[] };
export type DividerBlock = { type: "divider" };
export type InputBlock = {
  type: "input";
  block_id: string;
  label: PlainText;
  element: Element;
  optional?: boolean;
};
export type Block = HeaderBlock | SectionBlock | ActionsBlock | ContextBlock | DividerBlock | InputBlock;

export type ModalView = {
  type: "modal";
  callback_id: string;
  title: PlainText;
  submit?: PlainText;
  close?: PlainText;
  blocks: Block[];
  private_metadata?: string;
};

export const plain = (text: string): PlainText => ({ type: "plain_text", text, emoji: true });
export const mrkdwn = (text: string): Mrkdwn => ({ type: "mrkdwn", text });
export const header = (text: string): HeaderBlock => ({ type: "header", text: plain(text) });
export const section = (text: string): SectionBlock => ({ type: "section", text: mrkdwn(text) });
export const context = (...texts: string[]): ContextBlock => ({
  type: "context",
  elements: texts.map(mrkdwn),
});
export const divider = (): DividerBlock => ({ type: "divider" });
export const actions = (...elements: Element[]): ActionsBlock => ({ type: "actions", elements });
export const option = (text: string, value: string): Option => ({ text: plain(text), value });
export const button = (
  text: string,
  actionId: string,
  opts: { value?: string; style?: "primary" | "danger"; url?: string } = {},
): Button => ({ type: "button", text: plain(text), action_id: actionId, ...opts });
export const staticSelect = (actionId: string, options: Option[], initial?: Option): StaticSelect => ({
  type: "static_select",
  action_id: actionId,
  options,
  ...(initial ? { initial_option: initial } : {}),
});
export const datepicker = (actionId: string, initialDate?: string): Datepicker => ({
  type: "datepicker",
  action_id: actionId,
  ...(initialDate ? { initial_date: initialDate } : {}),
});
export const textInput = (actionId: string, initialValue?: string, placeholder?: string): PlainTextInput => ({
  type: "plain_text_input",
  action_id: actionId,
  ...(initialValue ? { initial_value: initialValue } : {}),
  ...(placeholder ? { placeholder: plain(placeholder) } : {}),
});
export const input = (blockId: string, label: string, element: Element, optional = false): InputBlock => ({
  type: "input",
  block_id: blockId,
  label: plain(label),
  element,
  optional,
});
```

- [ ] **Step 2: Failing tests for the real client (mocked fetch) and the fake**

`packages/core/src/slack/client.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { header } from "./blocks";
import { RealSlackClient, SlackApiError } from "./client";

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("RealSlackClient", () => {
  it("opens a view with the bot token and returns the view id", async () => {
    const fetchFn = fetchReturning({ ok: true, view: { id: "V123" } });
    const slack = new RealSlackClient(fetchFn);
    const result = await slack.openView({
      botToken: "xoxb-1",
      triggerId: "trig",
      view: { type: "modal", callback_id: "cb", title: { type: "plain_text", text: "t" }, blocks: [header("h")] },
    });
    expect(result.viewId).toBe("V123");
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/views.open");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-1");
    expect(JSON.parse(init.body as string).trigger_id).toBe("trig");
  });

  it("sets a user status with the user token", async () => {
    const fetchFn = fetchReturning({ ok: true });
    const slack = new RealSlackClient(fetchFn);
    await slack.setUserStatus({ userToken: "xoxp-1", text: "Out", emoji: ":palm_tree:", expiration: 1700000000 });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/users.profile.set");
    expect(JSON.parse(init.body as string)).toEqual({
      profile: { status_text: "Out", status_emoji: ":palm_tree:", status_expiration: 1700000000 },
    });
  });

  it("throws SlackApiError with Slack's error code", async () => {
    const slack = new RealSlackClient(fetchReturning({ ok: false, error: "invalid_auth" }));
    await expect(slack.clearUserStatus({ userToken: "bad" })).rejects.toEqual(
      new SlackApiError("users.profile.set", "invalid_auth"),
    );
  });

  it("posts to a response_url and fails on a non-2xx", async () => {
    const ok = new RealSlackClient(fetchReturning({}, 200));
    await expect(ok.respond({ responseUrl: "https://hooks.slack.com/x", text: "hi" })).resolves.toBeUndefined();
    const bad = new RealSlackClient(fetchReturning({}, 500));
    await expect(bad.respond({ responseUrl: "https://hooks.slack.com/x", text: "hi" })).rejects.toEqual(
      new SlackApiError("response_url", "http_500"),
    );
  });
});
```

`packages/core/src/slack/fake.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SlackApiError } from "./client";
import { FakeSlackClient } from "./fake";

describe("FakeSlackClient", () => {
  it("records statuses per user token and clears them", async () => {
    const slack = new FakeSlackClient();
    await slack.setUserStatus({ userToken: "xoxp-dana", text: "Out", emoji: ":palm_tree:", expiration: 10 });
    expect(slack.statuses.get("xoxp-dana")).toEqual({ text: "Out", emoji: ":palm_tree:", expiration: 10 });
    await slack.clearUserStatus({ userToken: "xoxp-dana" });
    expect(slack.statuses.get("xoxp-dana")).toBeNull();
  });

  it("fails the next call of a method once when asked", async () => {
    const slack = new FakeSlackClient();
    slack.failNext.setUserStatus = "ratelimited";
    await expect(
      slack.setUserStatus({ userToken: "t", text: "x", emoji: ":x:", expiration: 0 }),
    ).rejects.toEqual(new SlackApiError("setUserStatus", "ratelimited"));
    await expect(
      slack.setUserStatus({ userToken: "t", text: "x", emoji: ":x:", expiration: 0 }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm exec vitest run packages/core/src/slack`
Expected: FAIL — imports `./client` and `./fake` unresolved (the verify tests still pass).

- [ ] **Step 4: Implement the clients**

`packages/core/src/slack/client.ts`:
```ts
import type { Block, ModalView } from "./blocks";

export type RespondArgs = {
  responseUrl: string;
  text: string;
  blocks?: Block[];
  responseType?: "ephemeral" | "in_channel";
  replaceOriginal?: boolean;
};

export type SetStatusArgs = {
  userToken: string;
  text: string;
  emoji: string;
  /** Unix seconds; 0 means no expiry. */
  expiration: number;
};

export interface SlackClient {
  openView(args: { botToken: string; triggerId: string; view: ModalView }): Promise<{ viewId: string }>;
  respond(args: RespondArgs): Promise<void>;
  setUserStatus(args: SetStatusArgs): Promise<void>;
  clearUserStatus(args: { userToken: string }): Promise<void>;
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`${method}: ${code}`);
    this.name = "SlackApiError";
  }
}

type ApiResponse = { ok: boolean; error?: string } & Record<string, unknown>;

export class RealSlackClient implements SlackClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  private async call(method: string, token: string, body: Record<string, unknown>): Promise<ApiResponse> {
    const res = await this.fetchFn(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as ApiResponse;
    if (!data.ok) throw new SlackApiError(method, data.error ?? "unknown_error");
    return data;
  }

  async openView(args: { botToken: string; triggerId: string; view: ModalView }): Promise<{ viewId: string }> {
    const data = await this.call("views.open", args.botToken, { trigger_id: args.triggerId, view: args.view });
    return { viewId: (data.view as { id: string }).id };
  }

  async respond(args: RespondArgs): Promise<void> {
    const res = await this.fetchFn(args.responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: args.text,
        blocks: args.blocks,
        response_type: args.responseType ?? "ephemeral",
        replace_original: args.replaceOriginal ?? false,
      }),
    });
    if (!res.ok) throw new SlackApiError("response_url", `http_${res.status}`);
  }

  async setUserStatus(args: SetStatusArgs): Promise<void> {
    await this.call("users.profile.set", args.userToken, {
      profile: { status_text: args.text, status_emoji: args.emoji, status_expiration: args.expiration },
    });
  }

  async clearUserStatus(args: { userToken: string }): Promise<void> {
    await this.call("users.profile.set", args.userToken, {
      profile: { status_text: "", status_emoji: "", status_expiration: 0 },
    });
  }
}
```

`packages/core/src/slack/fake.ts`:
```ts
import type { ModalView } from "./blocks";
import { type RespondArgs, type SetStatusArgs, SlackApiError, type SlackClient } from "./client";

export type FakeStatus = { text: string; emoji: string; expiration: number };

/** In-memory Slack: records every call so tests and the demo can read what "Slack" now holds. */
export class FakeSlackClient implements SlackClient {
  openedViews: { triggerId: string; view: ModalView }[] = [];
  responses: RespondArgs[] = [];
  statuses = new Map<string, FakeStatus | null>();
  /** Set a method name to a Slack error code to make its next call fail once. */
  failNext: Partial<Record<keyof SlackClient, string>> = {};

  private maybeFail(method: keyof SlackClient): void {
    const code = this.failNext[method];
    if (code) {
      delete this.failNext[method];
      throw new SlackApiError(method, code);
    }
  }

  async openView(args: { botToken: string; triggerId: string; view: ModalView }): Promise<{ viewId: string }> {
    this.maybeFail("openView");
    this.openedViews.push({ triggerId: args.triggerId, view: args.view });
    return { viewId: `V${this.openedViews.length}` };
  }

  async respond(args: RespondArgs): Promise<void> {
    this.maybeFail("respond");
    this.responses.push(args);
  }

  async setUserStatus(args: SetStatusArgs): Promise<void> {
    this.maybeFail("setUserStatus");
    this.statuses.set(args.userToken, { text: args.text, emoji: args.emoji, expiration: args.expiration });
  }

  async clearUserStatus(args: { userToken: string }): Promise<void> {
    this.maybeFail("clearUserStatus");
    this.statuses.set(args.userToken, null);
  }
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from "./slack/blocks";
export { RealSlackClient, SlackApiError } from "./slack/client";
export type { RespondArgs, SetStatusArgs, SlackClient } from "./slack/client";
export { FakeSlackClient } from "./slack/fake";
export type { FakeStatus } from "./slack/fake";
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm exec vitest run packages/core/src/slack`
Expected: all tests in `verify`, `client` and `fake` PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): Block Kit builders and Slack client with a recording fake

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The act-with-receipt engine

**Files:**
- Create: `packages/core/src/engine/connector.ts`, `packages/core/src/engine/engine.ts`
- Test: `packages/core/src/engine/engine.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Db`, `statusTargets`, `audit`, `newId` (Task 4).
- Produces: `WriteSpec = { system: string; op: string; args: Record<string, unknown> }`; `ConnectorCtx = { workspaceId: string; personId: string; userToken: string | null }`; `Connector { system; perform(spec, ctx): Promise<{ externalId: string }>; undo(externalId, spec, ctx): Promise<void> }`; `ConnectorRegistry.register(c).get(system)`; `SkipWrite(reason)`; `createTargets(db, statusId, specs): Promise<TargetRow[]>`; `targetsForStatus(db, statusId)`; `executeTargets(db, registry, ctx, targets, now)`; `undoTargets(db, registry, ctx, targets, now)`. Target states: `pending | done | failed | skipped | undone`.

- [ ] **Step 1: Connector contract**

`packages/core/src/engine/connector.ts`:
```ts
export type WriteSpec = { system: string; op: string; args: Record<string, unknown> };

export type ConnectorCtx = { workspaceId: string; personId: string; userToken: string | null };

/** One external system. `perform` does the write; `undo` reverses it. */
export interface Connector {
  readonly system: string;
  perform(spec: WriteSpec, ctx: ConnectorCtx): Promise<{ externalId: string }>;
  undo(externalId: string, spec: WriteSpec, ctx: ConnectorCtx): Promise<void>;
}

/** Thrown by a connector to record a target as skipped (not failed) with a plain-words reason. */
export class SkipWrite extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SkipWrite";
  }
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();
  register(connector: Connector): this {
    this.connectors.set(connector.system, connector);
    return this;
  }
  get(system: string): Connector | undefined {
    return this.connectors.get(system);
  }
}
```

- [ ] **Step 2: Failing engine tests**

`packages/core/src/engine/engine.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { audit, statuses } from "../db/schema";
import { createTestDb } from "../testing";
import { type Connector, type ConnectorCtx, ConnectorRegistry, SkipWrite, type WriteSpec } from "./connector";
import { createTargets, executeTargets, targetsForStatus, undoTargets } from "./engine";

class RecordingConnector implements Connector {
  performed: WriteSpec[] = [];
  undone: string[] = [];
  constructor(
    readonly system: string,
    private readonly behaviour: "ok" | "fail" | "skip" = "ok",
  ) {}
  async perform(spec: WriteSpec): Promise<{ externalId: string }> {
    if (this.behaviour === "fail") throw new Error("rate limited by the other side");
    if (this.behaviour === "skip") throw new SkipWrite("not connected yet");
    this.performed.push(spec);
    return { externalId: `ext-${this.performed.length}` };
  }
  async undo(externalId: string): Promise<void> {
    this.undone.push(externalId);
  }
}

const ctx: ConnectorCtx = { workspaceId: "T1", personId: "T1:U1", userToken: "xoxp" };
const now = () => 1_700_000_000_000;

describe("engine", () => {
  let db: Db;
  beforeEach(async () => {
    db = createTestDb();
    await db.insert(statuses).values({
      id: "S1", workspaceId: "T1", personId: "T1:U1", type: "out", startMs: 1, endMs: 2, text: "Out", emoji: ":x:",
      state: "active", source: "form", createdAt: 0, undoUntilMs: null, replacedStatusId: null,
    });
  });

  it("creates pending targets with idempotency keys", async () => {
    const targets = await createTargets(db, "S1", [
      { system: "a", op: "set", args: { v: 1 } },
      { system: "b", op: "set", args: {} },
    ]);
    expect(targets.map((t) => t.state)).toEqual(["pending", "pending"]);
    expect(targets.map((t) => t.idempotencyKey)).toEqual(["S1:a:set", "S1:b:set"]);
    expect(await targetsForStatus(db, "S1")).toHaveLength(2);
  });

  it("runs each target independently and records honest states", async () => {
    const a = new RecordingConnector("a");
    const registry = new ConnectorRegistry()
      .register(a)
      .register(new RecordingConnector("b", "fail"))
      .register(new RecordingConnector("c", "skip"));
    const created = await createTargets(db, "S1", [
      { system: "a", op: "set", args: { v: 1 } },
      { system: "b", op: "set", args: {} },
      { system: "c", op: "set", args: {} },
      { system: "d", op: "set", args: {} },
    ]);
    const result = await executeTargets(db, registry, ctx, created, now);
    const byState = Object.fromEntries(result.map((t) => [t.system, [t.state, t.lastError, t.externalId]]));
    expect(byState).toEqual({
      a: ["done", null, "ext-1"],
      b: ["failed", "rate limited by the other side", null],
      c: ["skipped", "not connected yet", null],
      d: ["skipped", "no connector for d", null],
    });
    expect(a.performed).toEqual([{ system: "a", op: "set", args: { v: 1 } }]);
    const auditRows = await db.select().from(audit).where(eq(audit.workspaceId, "T1"));
    expect(auditRows.map((r) => `${r.action}:${r.result}`).sort()).toEqual(
      ["a.set:done", "b.set:failed", "c.set:skipped", "d.set:skipped"].sort(),
    );
  });

  it("undo reverses done targets, retires pending ones and leaves failed ones alone", async () => {
    const a = new RecordingConnector("a");
    const registry = new ConnectorRegistry().register(a).register(new RecordingConnector("b", "fail"));
    const created = await createTargets(db, "S1", [
      { system: "a", op: "set", args: {} },
      { system: "b", op: "set", args: {} },
      { system: "a", op: "later", args: {} },
    ]);
    const [done, failed, pending] = await executeTargets(db, registry, ctx, created.slice(0, 2), now).then(
      async () => targetsForStatus(db, "S1"),
    );
    expect([done?.state, failed?.state, pending?.state]).toEqual(["done", "failed", "pending"]);
    const after = await undoTargets(db, registry, ctx, await targetsForStatus(db, "S1"), now);
    const states = Object.fromEntries(after.map((t) => [`${t.system}.${t.op}`, t.state]));
    expect(states).toEqual({ "a.set": "undone", "b.set": "failed", "a.later": "undone" });
    expect(a.undone).toEqual(["ext-1"]);
  });

  it("does not re-run a target that is no longer pending", async () => {
    const a = new RecordingConnector("a");
    const registry = new ConnectorRegistry().register(a);
    const created = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    const once = await executeTargets(db, registry, ctx, created, now);
    await executeTargets(db, registry, ctx, once, now);
    expect(a.performed).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm exec vitest run packages/core/src/engine`
Expected: FAIL — `Failed to resolve import "./engine"`.

- [ ] **Step 4: Implement the engine**

`packages/core/src/engine/engine.ts`:
```ts
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { type TargetRow, audit, statusTargets } from "../db/schema";
import { newId } from "../ids";
import { type ConnectorCtx, type ConnectorRegistry, SkipWrite, type WriteSpec } from "./connector";

export type TargetState = "pending" | "done" | "failed" | "skipped" | "undone";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function targetsById(db: Db, ids: string[]): Promise<TargetRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(statusTargets).where(inArray(statusTargets.id, ids));
}

export async function targetsForStatus(db: Db, statusId: string): Promise<TargetRow[]> {
  return db.select().from(statusTargets).where(eq(statusTargets.statusId, statusId));
}

/** One pending row per write. The idempotency key is stable across retries of the same status. */
export async function createTargets(db: Db, statusId: string, specs: WriteSpec[]): Promise<TargetRow[]> {
  const rows: TargetRow[] = specs.map((spec) => ({
    id: newId(),
    statusId,
    system: spec.system,
    op: spec.op,
    spec: JSON.stringify(spec),
    state: "pending",
    externalId: null,
    attempts: 0,
    lastError: null,
    idempotencyKey: `${statusId}:${spec.system}:${spec.op}`,
  }));
  if (rows.length > 0) await db.insert(statusTargets).values(rows);
  return rows;
}

type Patch = { state: TargetState; externalId?: string | null; lastError: string | null };

async function record(
  db: Db,
  ctx: ConnectorCtx,
  target: TargetRow,
  action: string,
  patch: Patch,
  at: number,
): Promise<void> {
  await db
    .update(statusTargets)
    .set({ ...patch, attempts: target.attempts + 1 })
    .where(eq(statusTargets.id, target.id));
  await db.insert(audit).values({
    id: newId(),
    workspaceId: ctx.workspaceId,
    personId: ctx.personId,
    action,
    result: patch.state,
    detail: patch.lastError,
    at,
    idempotencyKey: target.idempotencyKey,
  });
}

/** Runs every pending target independently; one failure never blocks another. */
export async function executeTargets(
  db: Db,
  registry: ConnectorRegistry,
  ctx: ConnectorCtx,
  targets: TargetRow[],
  now: () => number,
): Promise<TargetRow[]> {
  for (const target of targets) {
    if (target.state !== "pending") continue;
    const spec = JSON.parse(target.spec) as WriteSpec;
    const connector = registry.get(target.system);
    let patch: Patch;
    if (!connector) {
      patch = { state: "skipped", lastError: `no connector for ${target.system}` };
    } else {
      try {
        const { externalId } = await connector.perform(spec, ctx);
        patch = { state: "done", externalId, lastError: null };
      } catch (err) {
        patch =
          err instanceof SkipWrite
            ? { state: "skipped", lastError: err.reason }
            : { state: "failed", lastError: errorMessage(err) };
      }
    }
    await record(db, ctx, target, `${target.system}.${target.op}`, patch, now());
  }
  return targetsById(
    db,
    targets.map((t) => t.id),
  );
}

/** Reverses done targets through their connector; pending ones simply become undone; failed ones stay failed. */
export async function undoTargets(
  db: Db,
  registry: ConnectorRegistry,
  ctx: ConnectorCtx,
  targets: TargetRow[],
  now: () => number,
): Promise<TargetRow[]> {
  for (const target of targets) {
    const action = `${target.system}.${target.op}.undo`;
    if (target.state === "pending") {
      await record(db, ctx, target, action, { state: "undone", lastError: null }, now());
      continue;
    }
    if (target.state !== "done") continue;
    const spec = JSON.parse(target.spec) as WriteSpec;
    const connector = registry.get(target.system);
    let patch: Patch;
    if (!connector) {
      patch = { state: "done", lastError: `no connector for ${target.system}; could not undo` };
    } else {
      try {
        await connector.undo(target.externalId ?? "", spec, ctx);
        patch = { state: "undone", lastError: null };
      } catch (err) {
        patch = { state: "done", lastError: `undo didn't go through — ${errorMessage(err)}` };
      }
    }
    await record(db, ctx, target, action, patch, now());
  }
  return targetsById(
    db,
    targets.map((t) => t.id),
  );
}
```

Add to `packages/core/src/index.ts`:
```ts
export { ConnectorRegistry, SkipWrite } from "./engine/connector";
export type { Connector, ConnectorCtx, WriteSpec } from "./engine/connector";
export { createTargets, executeTargets, targetsForStatus, undoTargets } from "./engine/engine";
export type { TargetState } from "./engine/engine";
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run packages/core`
Expected: all core tests PASS (verify, seal, repo, client, fake, engine).

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): act-with-receipt engine with connectors, targets and audit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Availability — status types, time, form, plan, card, service, Slack-status connector

**Files:**
- Create: `packages/availability/package.json`, `packages/availability/tsconfig.json`, `packages/availability/src/index.ts`
- Create: `packages/availability/src/status/types.ts`, `.../status/time.ts`, `.../status/form.ts`, `.../status/plan.ts`, `.../status/card.ts`, `.../status/service.ts`, `.../connectors/slackStatus.ts`
- Test: `packages/availability/src/status/time.test.ts`, `.../status/form.test.ts`, `.../status/card.test.ts`, `.../status/service.test.ts`

**Interfaces:**
- Consumes: everything exported by `@steward/core` in Tasks 2–6.
- Produces: `STATUS_TYPES`, `STATUS_LABEL`, `STATUS_DEFAULTS`, `StatusInput = { type; from; to; text; emoji }`; `zonedTimeToEpochMs(date, time, tz)`, `todayIn(tz, nowMs)`, `nextDay(date)`, `formatRange(startMs, endMs, tz)`, `formatDay`, `formatTime`; `STATUS_MODAL_CALLBACK`, `buildStatusModal({ today, responseUrl, initial? })`, `readStatusSubmission(view)`; `SLACK_STATUS`, `planWrites(input, { startMs, endMs })`; `UNDO_ACTION`, `resultCard({ status, targets, tz, now })`; `UNDO_WINDOW_MS`, `AvailabilityDeps = { db; registry; now }`, `saveStatus(deps, person, input, userToken)`, `undoStatus(deps, statusId, person, userToken)`; `SlackStatusConnector(slack)`.

- [ ] **Step 1: Package shell**

`packages/availability/package.json`:
```json
{
  "name": "@steward/availability",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@steward/core": "workspace:*",
    "drizzle-orm": "^0.44.0"
  }
}
```

`packages/availability/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src"]
}
```

Run: `pnpm install`
Expected: workspace link created; no errors.

- [ ] **Step 2: Types**

`packages/availability/src/status/types.ts`:
```ts
export const STATUS_TYPES = ["out", "sick", "remote", "travelling"] as const;
export type StatusType = (typeof STATUS_TYPES)[number];

export const STATUS_LABEL: Record<StatusType, string> = {
  out: "Out of office",
  sick: "Sick",
  remote: "Remote",
  travelling: "Travelling",
};

export const STATUS_DEFAULTS: Record<StatusType, { emoji: string; text: string }> = {
  out: { emoji: ":palm_tree:", text: "Out of office" },
  sick: { emoji: ":face_with_thermometer:", text: "Out sick" },
  remote: { emoji: ":house:", text: "Working remotely" },
  travelling: { emoji: ":airplane:", text: "Travelling" },
};

/** What the person asked for. Dates are local calendar dates (YYYY-MM-DD); `to` is the last day, inclusive. */
export type StatusInput = { type: StatusType; from: string; to: string; text: string; emoji: string };
```

- [ ] **Step 3: Failing time tests**

`packages/availability/src/status/time.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatRange, nextDay, todayIn, zonedTimeToEpochMs } from "./time";

describe("zonedTimeToEpochMs", () => {
  it("converts a local midnight in Asia/Jerusalem (UTC+2 in November)", () => {
    expect(zonedTimeToEpochMs("2026-11-12", "00:00", "Asia/Jerusalem")).toBe(Date.UTC(2026, 10, 11, 22, 0));
  });
  it("converts a local 09:00 in Europe/Warsaw in winter (UTC+1) and summer (UTC+2)", () => {
    expect(zonedTimeToEpochMs("2026-11-12", "09:00", "Europe/Warsaw")).toBe(Date.UTC(2026, 10, 12, 8, 0));
    expect(zonedTimeToEpochMs("2026-07-01", "09:00", "Europe/Warsaw")).toBe(Date.UTC(2026, 6, 1, 7, 0));
  });
  it("is the identity for UTC", () => {
    expect(zonedTimeToEpochMs("2026-01-01", "00:00", "UTC")).toBe(Date.UTC(2026, 0, 1));
  });
});

describe("todayIn", () => {
  it("returns the local calendar date of an instant", () => {
    const eveningUtc = Date.UTC(2026, 10, 8, 20, 0);
    expect(todayIn("Asia/Tokyo", eveningUtc)).toBe("2026-11-09");
    expect(todayIn("America/Los_Angeles", eveningUtc)).toBe("2026-11-08");
  });
});

describe("nextDay", () => {
  it("rolls over months and years", () => {
    expect(nextDay("2026-11-30")).toBe("2026-12-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("formatRange", () => {
  const tz = "UTC";
  it("shows one day once and a range with an en dash", () => {
    const start = Date.UTC(2026, 10, 12);
    expect(formatRange(start, Date.UTC(2026, 10, 13), tz)).toMatch(/^Thu,? 12 Nov$/);
    expect(formatRange(start, Date.UTC(2026, 10, 18), tz)).toMatch(/^Thu,? 12 Nov – Tue,? 17 Nov$/);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm exec vitest run packages/availability/src/status/time.test.ts`
Expected: FAIL — `Failed to resolve import "./time"`.

- [ ] **Step 5: Implement time helpers**

`packages/availability/src/status/time.ts`:
```ts
/** Offset of `tz` from UTC at the given instant, in ms (positive east of UTC). */
export function tzOffsetMs(epochMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** A local calendar date and HH:MM in `tz` → the instant, as epoch ms. The model never does this; this does. */
export function zonedTimeToEpochMs(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

export function todayIn(tz: string, nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

export function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function formatDay(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(epochMs));
}

export function formatTime(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochMs));
}

/** "Thu 12 Nov" for one day, "Thu 12 Nov – Tue 17 Nov" for a range; `endMs` is exclusive. */
export function formatRange(startMs: number, endMs: number, tz: string): string {
  const first = formatDay(startMs, tz);
  const last = formatDay(endMs - 1, tz);
  return first === last ? first : `${first} – ${last}`;
}
```

Run: `pnpm exec vitest run packages/availability/src/status/time.test.ts`
Expected: PASS.

- [ ] **Step 6: Failing form tests**

`packages/availability/src/status/form.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { STATUS_MODAL_CALLBACK, buildStatusModal, readStatusSubmission } from "./form";

function values(v: { type?: string; from?: string; to?: string; text?: string | null; emoji?: string | null }) {
  return {
    callback_id: STATUS_MODAL_CALLBACK,
    private_metadata: JSON.stringify({ responseUrl: "https://hooks.slack.test/r1" }),
    state: {
      values: {
        type: { type: { type: "static_select", selected_option: v.type ? { value: v.type } : null } },
        from: { from: { type: "datepicker", selected_date: v.from ?? null } },
        to: { to: { type: "datepicker", selected_date: v.to ?? null } },
        text: { text: { type: "plain_text_input", value: v.text ?? null } },
        emoji: { emoji: { type: "plain_text_input", value: v.emoji ?? null } },
      },
    },
  };
}

describe("buildStatusModal", () => {
  it("has the five inputs, defaults to today, and carries the response_url", () => {
    const view = buildStatusModal({ today: "2026-11-12", responseUrl: "https://hooks.slack.test/r1" });
    expect(view.callback_id).toBe(STATUS_MODAL_CALLBACK);
    expect(view.blocks.map((b) => (b.type === "input" ? b.block_id : b.type))).toEqual([
      "type", "from", "to", "text", "emoji",
    ]);
    expect(JSON.parse(view.private_metadata ?? "{}")).toEqual({ responseUrl: "https://hooks.slack.test/r1" });
    const from = view.blocks[1];
    expect(from?.type === "input" && from.element.type === "datepicker" && from.element.initial_date).toBe("2026-11-12");
  });
});

describe("readStatusSubmission", () => {
  it("reads a full submission", () => {
    const result = readStatusSubmission(
      values({ type: "out", from: "2026-11-12", to: "2026-11-17", text: "Away", emoji: ":beach:" }),
    );
    expect(result).toEqual({
      ok: true,
      input: { type: "out", from: "2026-11-12", to: "2026-11-17", text: "Away", emoji: ":beach:" },
      meta: { responseUrl: "https://hooks.slack.test/r1" },
    });
  });

  it("fills blank text and emoji from the type's defaults", () => {
    const result = readStatusSubmission(values({ type: "sick", from: "2026-11-12", to: "2026-11-12", text: "  " }));
    expect(result.ok && result.input.text).toBe("Out sick");
    expect(result.ok && result.input.emoji).toBe(":face_with_thermometer:");
  });

  it("rejects an end before the start, and a missing type, with field errors", () => {
    const bad = readStatusSubmission(values({ type: "out", from: "2026-11-12", to: "2026-11-11" }));
    expect(bad).toEqual({ ok: false, errors: { to: "The last day can't be before the first" } });
    const noType = readStatusSubmission(values({ from: "2026-11-12", to: "2026-11-12" }));
    expect(!noType.ok && noType.errors.type).toBe("Pick what's happening");
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `pnpm exec vitest run packages/availability/src/status/form.test.ts`
Expected: FAIL — `Failed to resolve import "./form"`.

- [ ] **Step 8: Implement the form**

`packages/availability/src/status/form.ts`:
```ts
import { type ModalView, datepicker, input, option, plain, staticSelect, textInput } from "@steward/core";
import { STATUS_DEFAULTS, STATUS_LABEL, STATUS_TYPES, type StatusInput, type StatusType } from "./types";

export const STATUS_MODAL_CALLBACK = "ooo_status";
export const FIELD = { type: "type", from: "from", to: "to", text: "text", emoji: "emoji" } as const;

export type ModalMeta = { responseUrl: string };

export function buildStatusModal(opts: {
  today: string;
  responseUrl: string;
  initial?: Partial<StatusInput>;
}): ModalView {
  const type: StatusType = opts.initial?.type ?? "out";
  const defaults = STATUS_DEFAULTS[type];
  const meta: ModalMeta = { responseUrl: opts.responseUrl };
  const from = opts.initial?.from ?? opts.today;
  return {
    type: "modal",
    callback_id: STATUS_MODAL_CALLBACK,
    title: plain("Set your availability"),
    submit: plain("Save"),
    close: plain("Cancel"),
    private_metadata: JSON.stringify(meta),
    blocks: [
      input(
        FIELD.type,
        "What's happening?",
        staticSelect(
          FIELD.type,
          STATUS_TYPES.map((t) => option(STATUS_LABEL[t], t)),
          option(STATUS_LABEL[type], type),
        ),
      ),
      input(FIELD.from, "From", datepicker(FIELD.from, from)),
      input(FIELD.to, "To (last day)", datepicker(FIELD.to, opts.initial?.to ?? from)),
      input(FIELD.text, "Status text", textInput(FIELD.text, opts.initial?.text ?? defaults.text), true),
      input(FIELD.emoji, "Emoji", textInput(FIELD.emoji, opts.initial?.emoji ?? defaults.emoji, ":palm_tree:"), true),
    ],
  };
}

type ValueNode = {
  type: string;
  value?: string | null;
  selected_date?: string | null;
  selected_option?: { value: string } | null;
};
export type ViewState = { values: Record<string, Record<string, ValueNode>> };
export type SubmittedView = { callback_id: string; private_metadata?: string; state: ViewState };
export type ReadResult =
  | { ok: true; input: StatusInput; meta: ModalMeta }
  | { ok: false; errors: Record<string, string> };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isStatusType(v: string): v is StatusType {
  return (STATUS_TYPES as readonly string[]).includes(v);
}

export function readStatusSubmission(view: SubmittedView): ReadResult {
  const node = (block: string): ValueNode | undefined => view.state.values[block]?.[block];
  const type = node(FIELD.type)?.selected_option?.value ?? "";
  const from = node(FIELD.from)?.selected_date ?? "";
  const to = node(FIELD.to)?.selected_date ?? "";

  const errors: Record<string, string> = {};
  if (!isStatusType(type)) errors[FIELD.type] = "Pick what's happening";
  if (!DATE.test(from)) errors[FIELD.from] = "Pick a start date";
  if (!DATE.test(to)) errors[FIELD.to] = "Pick an end date";
  else if (DATE.test(from) && to < from) errors[FIELD.to] = "The last day can't be before the first";
  if (!isStatusType(type) || Object.keys(errors).length > 0) return { ok: false, errors };

  const defaults = STATUS_DEFAULTS[type];
  const text = (node(FIELD.text)?.value ?? "").trim() || defaults.text;
  const emoji = (node(FIELD.emoji)?.value ?? "").trim() || defaults.emoji;
  let meta: ModalMeta = { responseUrl: "" };
  try {
    meta = { responseUrl: "", ...(JSON.parse(view.private_metadata ?? "{}") as Partial<ModalMeta>) };
  } catch {
    // malformed metadata: keep the empty response_url and still save
  }
  return { ok: true, input: { type, from, to, text, emoji }, meta };
}
```

Run: `pnpm exec vitest run packages/availability/src/status/form.test.ts`
Expected: PASS.

- [ ] **Step 9: Plan and connector**

`packages/availability/src/status/plan.ts`:
```ts
import type { WriteSpec } from "@steward/core";
import type { StatusInput } from "./types";

export const SLACK_STATUS = "slack-status";

/** Which systems get written for a status. Slack always; Calendar and Gmail arrive in Plan 3. */
export function planWrites(input: StatusInput, times: { startMs: number; endMs: number }): WriteSpec[] {
  return [
    {
      system: SLACK_STATUS,
      op: "set",
      args: { text: input.text, emoji: input.emoji, expiration: Math.floor(times.endMs / 1000) },
    },
  ];
}
```

`packages/availability/src/connectors/slackStatus.ts`:
```ts
import { type Connector, type ConnectorCtx, SkipWrite, type SlackClient, type WriteSpec } from "@steward/core";
import { SLACK_STATUS } from "../status/plan";

type Args = { text: string; emoji: string; expiration: number };

/** Sets and clears the person's own Slack status. Needs their user token (users.profile:write). */
export class SlackStatusConnector implements Connector {
  readonly system = SLACK_STATUS;
  constructor(private readonly slack: SlackClient) {}

  async perform(spec: WriteSpec, ctx: ConnectorCtx): Promise<{ externalId: string }> {
    if (!ctx.userToken) throw new SkipWrite("Slack isn't connected for you yet — use Connect Slack first");
    const { text, emoji, expiration } = spec.args as Args;
    await this.slack.setUserStatus({ userToken: ctx.userToken, text, emoji, expiration });
    return { externalId: `${ctx.personId}:${expiration}` };
  }

  async undo(_externalId: string, _spec: WriteSpec, ctx: ConnectorCtx): Promise<void> {
    if (!ctx.userToken) return;
    await this.slack.clearUserStatus({ userToken: ctx.userToken });
  }
}
```

- [ ] **Step 10: Failing card tests**

`packages/availability/src/status/card.test.ts`:
```ts
import type { StatusRow, TargetRow } from "@steward/core";
import { describe, expect, it } from "vitest";
import { UNDO_ACTION, resultCard } from "./card";

const now = Date.UTC(2026, 10, 12, 8, 0);
const status: StatusRow = {
  id: "S1", workspaceId: "T1", personId: "T1:U1", type: "out",
  startMs: Date.UTC(2026, 10, 11, 22), endMs: Date.UTC(2026, 10, 17, 22), text: "Out of office", emoji: ":palm_tree:",
  state: "active", source: "form", createdAt: now, undoUntilMs: now + 300_000, replacedStatusId: null,
};
const target = (state: string, lastError: string | null = null): TargetRow => ({
  id: "G1", statusId: "S1", system: "slack-status", op: "set", spec: "{}", state, externalId: null, attempts: 1,
  lastError, idempotencyKey: "S1:slack-status:set",
});

describe("resultCard", () => {
  it("shows the headline, one honest line per system, and Undo inside the window", () => {
    const card = resultCard({ status, targets: [target("done")], tz: "Asia/Jerusalem", now });
    expect(card.text).toMatch(/^Out of office · Thu,? 12 Nov – Tue,? 17 Nov$/);
    const lines = card.blocks[1];
    expect(lines?.type === "section" && lines.text?.text).toContain("✅ Slack status set");
    const buttons = card.blocks[2];
    expect(buttons?.type === "actions" && buttons.elements[0]?.type === "button" && buttons.elements[0].action_id).toBe(UNDO_ACTION);
    expect(buttons?.type === "actions" && buttons.elements[0]?.type === "button" && buttons.elements[0].value).toBe("S1");
  });

  it("words failures and skips plainly", () => {
    const failed = resultCard({ status, targets: [target("failed", "ratelimited")], tz: "UTC", now });
    expect(failed.blocks[1]?.type === "section" && failed.blocks[1].text?.text).toBe(
      "❌ Slack status didn't go through — ratelimited",
    );
    const skipped = resultCard({ status, targets: [target("skipped", "Slack isn't connected for you yet — use Connect Slack first")], tz: "UTC", now });
    expect(skipped.blocks[1]?.type === "section" && skipped.blocks[1].text?.text).toContain("➖ Slack status skipped — Slack isn't connected");
  });

  it("drops Undo after the window and after an undo", () => {
    const late = resultCard({ status, targets: [target("done")], tz: "UTC", now: now + 400_000 });
    expect(late.blocks.some((b) => b.type === "actions")).toBe(false);
    const undone = resultCard({
      status: { ...status, state: "cancelled", undoUntilMs: null },
      targets: [target("undone")],
      tz: "UTC",
      now,
    });
    expect(undone.text.startsWith("Undone · Out of office")).toBe(true);
    expect(undone.blocks[1]?.type === "section" && undone.blocks[1].text?.text).toBe("↩️ Slack status cleared");
  });
});
```

- [ ] **Step 11: Run to verify it fails**

Run: `pnpm exec vitest run packages/availability/src/status/card.test.ts`
Expected: FAIL — `Failed to resolve import "./card"`.

- [ ] **Step 12: Implement the card**

`packages/availability/src/status/card.ts`:
```ts
import { type Block, type StatusRow, type TargetRow, actions, button, context, header, section } from "@steward/core";
import { formatDay, formatRange, formatTime } from "./time";
import { STATUS_LABEL, type StatusType } from "./types";

export const UNDO_ACTION = "status_undo";

const SYSTEM_NAME: Record<string, string> = { "slack-status": "Slack status" };

/** One line per system write, in the words the spec uses: done, didn't go through, skipped, cleared, pending. */
export function targetLine(target: TargetRow, status: StatusRow, tz: string): string {
  const name = SYSTEM_NAME[target.system] ?? target.system;
  switch (target.state) {
    case "done":
      return `✅ ${name} set — clears ${formatDay(status.endMs - 1, tz)}`;
    case "failed":
      return `❌ ${name} didn't go through — ${target.lastError ?? "unknown error"}`;
    case "skipped":
      return `➖ ${name} skipped — ${target.lastError ?? "no reason recorded"}`;
    case "undone":
      return `↩️ ${name} cleared`;
    default:
      return `⏳ ${name} — will be set when it starts (${formatDay(status.startMs, tz)})`;
  }
}

export function resultCard(args: {
  status: StatusRow;
  targets: TargetRow[];
  tz: string;
  now: number;
}): { text: string; blocks: Block[] } {
  const { status, targets, tz, now } = args;
  const label = STATUS_LABEL[status.type as StatusType] ?? status.type;
  const range = formatRange(status.startMs, status.endMs, tz);
  const title = status.state === "cancelled" ? `Undone · ${label} · ${range}` : `${label} · ${range}`;
  const lines = targets.map((t) => targetLine(t, status, tz)).join("\n");
  const blocks: Block[] = [header(title), section(lines || "Nothing to write for this status.")];
  const canUndo = status.state !== "cancelled" && status.undoUntilMs !== null && status.undoUntilMs > now;
  if (canUndo && status.undoUntilMs !== null) {
    blocks.push(actions(button("Undo", UNDO_ACTION, { value: status.id, style: "danger" })));
    blocks.push(context(`You can undo until ${formatTime(status.undoUntilMs, tz)}.`));
  }
  return { text: title, blocks };
}
```

Run: `pnpm exec vitest run packages/availability/src/status/card.test.ts`
Expected: PASS.

- [ ] **Step 13: Failing service tests**

`packages/availability/src/status/service.test.ts`:
```ts
import { ConnectorRegistry, type Db, FakeSlackClient, type PersonRow, ensurePerson, schema, upsertWorkspace } from "@steward/core";
import { createTestDb } from "@steward/core/testing";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { SlackStatusConnector } from "../connectors/slackStatus";
import { type AvailabilityDeps, saveStatus, undoStatus } from "./service";
import { zonedTimeToEpochMs } from "./time";

const TZ = "Asia/Jerusalem";
const NOW = Date.UTC(2026, 10, 12, 8, 0); // Thu 12 Nov 2026, 10:00 local

describe("saveStatus / undoStatus", () => {
  let db: Db;
  let slack: FakeSlackClient;
  let deps: AvailabilityDeps;
  let dana: PersonRow;
  let clock: number;

  beforeEach(async () => {
    db = createTestDb();
    slack = new FakeSlackClient();
    clock = NOW;
    deps = { db, registry: new ConnectorRegistry().register(new SlackStatusConnector(slack)), now: () => clock };
    await upsertWorkspace(db, { id: "T1", name: "Acme", botTokenSealed: "x", botUserId: "UBOT", installedAt: 0 });
    dana = await ensurePerson(db, "T1", "U_DANA", "Dana");
    await db.update(schema.people).set({ tz: TZ }).where(eq(schema.people.id, dana.id));
    dana = { ...dana, tz: TZ };
  });

  it("an active status sets Slack now, with expiry at the end of the last day", async () => {
    const { status, targets } = await saveStatus(
      deps, dana, { type: "out", from: "2026-11-12", to: "2026-11-17", text: "Out", emoji: ":palm_tree:" }, "xoxp-dana",
    );
    expect(status.state).toBe("active");
    expect(targets[0]?.state).toBe("done");
    expect(slack.statuses.get("xoxp-dana")).toEqual({
      text: "Out", emoji: ":palm_tree:", expiration: zonedTimeToEpochMs("2026-11-18", "00:00", TZ) / 1000,
    });
  });

  it("a future status is saved as scheduled and writes nothing yet", async () => {
    const { status, targets } = await saveStatus(
      deps, dana, { type: "remote", from: "2026-11-20", to: "2026-11-20", text: "Remote", emoji: ":house:" }, "xoxp-dana",
    );
    expect(status.state).toBe("scheduled");
    expect(targets[0]?.state).toBe("pending");
    expect(slack.statuses.size).toBe(0);
  });

  it("without a Slack user token the write is skipped with a plain reason", async () => {
    const { targets } = await saveStatus(
      deps, dana, { type: "sick", from: "2026-11-12", to: "2026-11-12", text: "Out sick", emoji: ":x:" }, null,
    );
    expect(targets[0]?.state).toBe("skipped");
    expect(targets[0]?.lastError).toContain("isn't connected");
  });

  it("undo clears Slack, marks the status cancelled, and refuses after five minutes", async () => {
    const saved = await saveStatus(
      deps, dana, { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" }, "xoxp-dana",
    );
    const undone = await undoStatus(deps, saved.status.id, dana, "xoxp-dana");
    expect("error" in undone).toBe(false);
    if ("error" in undone) return;
    expect(undone.status.state).toBe("cancelled");
    expect(undone.targets[0]?.state).toBe("undone");
    expect(slack.statuses.get("xoxp-dana")).toBeNull();

    const again = await saveStatus(
      deps, dana, { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" }, "xoxp-dana",
    );
    clock = NOW + 6 * 60 * 1000;
    const late = await undoStatus(deps, again.status.id, dana, "xoxp-dana");
    expect(late).toEqual({ error: "The five-minute undo window has passed." });
  });

  it("saving over an active status ends the earlier one and records it as replaced", async () => {
    const first = await saveStatus(
      deps, dana, { type: "remote", from: "2026-11-12", to: "2026-11-12", text: "Remote", emoji: ":house:" }, "xoxp-dana",
    );
    const second = await saveStatus(
      deps, dana, { type: "out", from: "2026-11-12", to: "2026-11-13", text: "Out", emoji: ":x:" }, "xoxp-dana",
    );
    expect(second.status.replacedStatusId).toBe(first.status.id);
    const rows = await db.select().from(schema.statuses).where(eq(schema.statuses.id, first.status.id));
    expect(rows[0]?.state).toBe("ended");
  });

  it("refuses to undo someone else's status", async () => {
    const saved = await saveStatus(
      deps, dana, { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" }, "xoxp-dana",
    );
    const omer = await ensurePerson(db, "T1", "U_OMER", "Omer");
    expect(await undoStatus(deps, saved.status.id, omer, "xoxp-omer")).toEqual({
      error: "That status isn't yours or no longer exists.",
    });
  });
});
```

- [ ] **Step 14: Run to verify it fails**

Run: `pnpm exec vitest run packages/availability/src/status/service.test.ts`
Expected: FAIL — `Failed to resolve import "./service"`.

- [ ] **Step 15: Implement the service**

`packages/availability/src/status/service.ts`:
```ts
import {
  type ConnectorCtx,
  type ConnectorRegistry,
  type Db,
  type PersonRow,
  type StatusRow,
  type TargetRow,
  createTargets,
  executeTargets,
  newId,
  schema,
  targetsForStatus,
  undoTargets,
} from "@steward/core";
import { and, eq } from "drizzle-orm";
import { planWrites } from "./plan";
import { nextDay, zonedTimeToEpochMs } from "./time";
import type { StatusInput } from "./types";

export const UNDO_WINDOW_MS = 5 * 60 * 1000;

export type AvailabilityDeps = { db: Db; registry: ConnectorRegistry; now: () => number };
export type SaveResult = { status: StatusRow; targets: TargetRow[] };

function ctxFor(person: PersonRow, userToken: string | null): ConnectorCtx {
  return { workspaceId: person.workspaceId, personId: person.id, userToken };
}

export async function getStatus(db: Db, id: string): Promise<StatusRow | null> {
  const rows = await db.select().from(schema.statuses).where(eq(schema.statuses.id, id));
  return rows[0] ?? null;
}

export async function activeStatusFor(db: Db, personId: string): Promise<StatusRow | null> {
  const rows = await db
    .select()
    .from(schema.statuses)
    .where(and(eq(schema.statuses.personId, personId), eq(schema.statuses.state, "active")));
  return rows[0] ?? null;
}

/**
 * The one save path. All-day statuses in the person's time zone; `endMs` is the midnight after the last day.
 * Active statuses write now; scheduled ones leave their targets pending for the tick (Plan 3).
 */
export async function saveStatus(
  deps: AvailabilityDeps,
  person: PersonRow,
  input: StatusInput,
  userToken: string | null,
): Promise<SaveResult> {
  const now = deps.now();
  const startMs = zonedTimeToEpochMs(input.from, "00:00", person.tz);
  const endMs = zonedTimeToEpochMs(nextDay(input.to), "00:00", person.tz);
  const previous = await activeStatusFor(deps.db, person.id);
  const status: StatusRow = {
    id: newId(),
    workspaceId: person.workspaceId,
    personId: person.id,
    type: input.type,
    startMs,
    endMs,
    text: input.text,
    emoji: input.emoji,
    state: startMs <= now ? "active" : "scheduled",
    source: "form",
    createdAt: now,
    undoUntilMs: now + UNDO_WINDOW_MS,
    replacedStatusId: previous?.id ?? null,
  };
  if (previous && status.state === "active") {
    await deps.db.update(schema.statuses).set({ state: "ended" }).where(eq(schema.statuses.id, previous.id));
  }
  await deps.db.insert(schema.statuses).values(status);
  let targets = await createTargets(deps.db, status.id, planWrites(input, { startMs, endMs }));
  if (status.state === "active") {
    targets = await executeTargets(deps.db, deps.registry, ctxFor(person, userToken), targets, deps.now);
  }
  return { status, targets };
}

/** Reverses every write of the person's own status inside the undo window and marks it cancelled. */
export async function undoStatus(
  deps: AvailabilityDeps,
  statusId: string,
  person: PersonRow,
  userToken: string | null,
): Promise<SaveResult | { error: string }> {
  const status = await getStatus(deps.db, statusId);
  if (!status || status.personId !== person.id) return { error: "That status isn't yours or no longer exists." };
  if (status.state === "cancelled") return { status, targets: await targetsForStatus(deps.db, status.id) };
  if (status.undoUntilMs === null || status.undoUntilMs < deps.now()) {
    return { error: "The five-minute undo window has passed." };
  }
  const targets = await undoTargets(
    deps.db,
    deps.registry,
    ctxFor(person, userToken),
    await targetsForStatus(deps.db, status.id),
    deps.now,
  );
  await deps.db
    .update(schema.statuses)
    .set({ state: "cancelled", undoUntilMs: null })
    .where(eq(schema.statuses.id, status.id));
  return { status: { ...status, state: "cancelled", undoUntilMs: null }, targets };
}
```

`packages/availability/src/index.ts`:
```ts
export { SlackStatusConnector } from "./connectors/slackStatus";
export { UNDO_ACTION, resultCard, targetLine } from "./status/card";
export { FIELD, STATUS_MODAL_CALLBACK, buildStatusModal, readStatusSubmission } from "./status/form";
export type { ModalMeta, ReadResult, SubmittedView, ViewState } from "./status/form";
export { SLACK_STATUS, planWrites } from "./status/plan";
export { UNDO_WINDOW_MS, activeStatusFor, getStatus, saveStatus, undoStatus } from "./status/service";
export type { AvailabilityDeps, SaveResult } from "./status/service";
export { formatDay, formatRange, formatTime, nextDay, todayIn, tzOffsetMs, zonedTimeToEpochMs } from "./status/time";
export { STATUS_DEFAULTS, STATUS_LABEL, STATUS_TYPES } from "./status/types";
export type { StatusInput, StatusType } from "./status/types";
```

- [ ] **Step 16: Run everything**

Run: `pnpm test && pnpm exec tsc --noEmit -p packages/availability && pnpm lint`
Expected: all tests PASS (core and availability); tsc silent; Biome clean (run `pnpm lint:fix` for formatting-only complaints, then re-run).

- [ ] **Step 17: Commit**

```bash
git add packages/availability pnpm-lock.yaml
git commit -m "feat(availability): status types, form, plan, receipt card, save/undo service, Slack-status connector

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The Worker — `/ooo` end to end against the fake Slack

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`
- Create: `apps/worker/src/env.ts`, `apps/worker/src/db.ts`, `apps/worker/src/deps.ts`, `apps/worker/src/slackTypes.ts`, `apps/worker/src/routes/slack.ts`, `apps/worker/src/app.ts`
- Test: `apps/worker/test/helpers.ts`, `apps/worker/test/ooo.test.ts`

**Interfaces:**
- Consumes: `@steward/core` and `@steward/availability` exports.
- Produces: `Env`; `Deps = { db; slack; fetchFn; now; signingSecret; tokenKey; slackClientId; slackClientSecret; appUrl }`; `depsFromEnv(env)`; `createD1Db(d1)`; `createApp(deps)` (Hono) with `GET /health`, `POST /slack/commands`, `POST /slack/interactions`; test helpers `testDeps()`, `seedWorkspace(deps, { withUserToken })`, `slackPost(app, path, form)`.

- [ ] **Step 1: Package shell**

`apps/worker/package.json`:
```json
{
  "name": "@steward/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "build": "wrangler deploy --dry-run --outdir dist",
    "deploy": "wrangler deploy",
    "db:migrate:local": "wrangler d1 migrations apply steward --local",
    "db:migrate:remote": "wrangler d1 migrations apply steward --remote"
  },
  "dependencies": {
    "@steward/availability": "workspace:*",
    "@steward/core": "workspace:*",
    "drizzle-orm": "^0.44.0",
    "hono": "^4.9.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20251001.0",
    "wrangler": "^4.40.0"
  }
}
```

`apps/worker/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types"], "lib": ["ES2022"] },
  "include": ["src"]
}
```
(Tests under `apps/worker/test` run on Node through Vitest and are not part of this tsconfig.)

Run: `pnpm install`
Expected: no errors.

- [ ] **Step 2: Env, db, deps, payload types**

`apps/worker/src/env.ts`:
```ts
export type Env = {
  DB: D1Database;
  SLACK_SIGNING_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  /** 32 random bytes, base64 — see `newKeyB64()` in @steward/core. */
  TOKEN_KEY: string;
  /** Public origin of this Worker, no trailing slash, e.g. https://steward.example.workers.dev */
  APP_URL: string;
};
```

`apps/worker/src/db.ts`:
```ts
import { type Db, schema } from "@steward/core";
import { drizzle } from "drizzle-orm/d1";

export function createD1Db(d1: D1Database): Db {
  return drizzle(d1, { schema }) as unknown as Db;
}
```

`apps/worker/src/deps.ts`:
```ts
import { type Db, RealSlackClient, type SlackClient } from "@steward/core";
import { createD1Db } from "./db";
import type { Env } from "./env";

/** Everything the app needs, built once per request in production and by hand in tests. */
export type Deps = {
  db: Db;
  slack: SlackClient;
  fetchFn: typeof fetch;
  now: () => number;
  signingSecret: string;
  tokenKey: string;
  slackClientId: string;
  slackClientSecret: string;
  appUrl: string;
};

export function depsFromEnv(env: Env): Deps {
  return {
    db: createD1Db(env.DB),
    slack: new RealSlackClient(fetch),
    fetchFn: fetch,
    now: () => Date.now(),
    signingSecret: env.SLACK_SIGNING_SECRET,
    tokenKey: env.TOKEN_KEY,
    slackClientId: env.SLACK_CLIENT_ID,
    slackClientSecret: env.SLACK_CLIENT_SECRET,
    appUrl: env.APP_URL,
  };
}
```

`apps/worker/src/slackTypes.ts`:
```ts
import type { SubmittedView } from "@steward/availability";

export type SlackUser = { id: string; username?: string; name?: string };

export type ViewSubmissionPayload = {
  type: "view_submission";
  team: { id: string };
  user: SlackUser;
  view: SubmittedView;
};

export type BlockActionsPayload = {
  type: "block_actions";
  team: { id: string };
  user: SlackUser;
  response_url?: string;
  actions: { action_id: string; value?: string }[];
};

export type InteractionPayload =
  | ViewSubmissionPayload
  | BlockActionsPayload
  | { type: string; team: { id: string }; user: SlackUser };
```

- [ ] **Step 3: Test helpers and the failing flow tests**

`apps/worker/test/helpers.ts`:
```ts
import {
  type Db,
  FakeSlackClient,
  type PersonRow,
  ensurePerson,
  newKeyB64,
  schema,
  seal,
  setPersonUserToken,
  slackSignature,
  upsertWorkspace,
} from "@steward/core";
import { createTestDb } from "@steward/core/testing";
import { eq } from "drizzle-orm";
import type { Deps } from "../src/deps";

export const SIGNING_SECRET = "test-signing-secret";
/** Thu 12 Nov 2026, 08:00 UTC = 10:00 in Asia/Jerusalem. */
export const NOW = Date.UTC(2026, 10, 12, 8, 0, 0);
export const TZ = "Asia/Jerusalem";

export type TestDeps = Deps & { db: Db; slack: FakeSlackClient; tokenKey: string; clock: { now: number } };

export function testDeps(overrides: Partial<Deps> = {}): TestDeps {
  const clock = { now: NOW };
  return {
    db: createTestDb(),
    slack: new FakeSlackClient(),
    tokenKey: newKeyB64(),
    fetchFn: fetch,
    now: () => clock.now,
    signingSecret: SIGNING_SECRET,
    slackClientId: "client-id",
    slackClientSecret: "client-secret",
    appUrl: "https://steward.example",
    clock,
    ...overrides,
  };
}

export async function seedWorkspace(deps: TestDeps, opts: { withUserToken: boolean } = { withUserToken: true }): Promise<PersonRow> {
  await upsertWorkspace(deps.db, {
    id: "T1",
    name: "Acme",
    botTokenSealed: await seal(deps.tokenKey, "xoxb-bot"),
    botUserId: "UBOT",
    installedAt: NOW - 1000,
  });
  let person = await ensurePerson(deps.db, "T1", "U_DANA", "dana");
  await deps.db.update(schema.people).set({ tz: TZ }).where(eq(schema.people.id, person.id));
  if (opts.withUserToken) person = await setPersonUserToken(deps.db, person.id, await seal(deps.tokenKey, "xoxp-dana"));
  return { ...person, tz: TZ };
}

type App = { request: (input: string, init?: RequestInit) => Promise<Response> | Response };

/** POSTs a form body to the app with a valid Slack signature for `nowMs`. */
export async function slackPost(app: App, path: string, form: Record<string, string>, nowMs = NOW): Promise<Response> {
  const body = new URLSearchParams(form).toString();
  const timestamp = String(Math.floor(nowMs / 1000));
  const signature = await slackSignature(SIGNING_SECRET, timestamp, body);
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}
```

`apps/worker/test/ooo.test.ts`:
```ts
import { STATUS_MODAL_CALLBACK, UNDO_ACTION, zonedTimeToEpochMs } from "@steward/availability";
import type { Block } from "@steward/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { NOW, TZ, type TestDeps, seedWorkspace, slackPost, testDeps } from "./helpers";

const RESPONSE_URL = "https://hooks.slack.test/r1";

function submission(v: { type: string; from: string; to: string; text?: string; emoji?: string }) {
  return {
    type: "view_submission",
    team: { id: "T1" },
    user: { id: "U_DANA", username: "dana" },
    view: {
      callback_id: STATUS_MODAL_CALLBACK,
      private_metadata: JSON.stringify({ responseUrl: RESPONSE_URL }),
      state: {
        values: {
          type: { type: { type: "static_select", selected_option: { value: v.type } } },
          from: { from: { type: "datepicker", selected_date: v.from } },
          to: { to: { type: "datepicker", selected_date: v.to } },
          text: { text: { type: "plain_text_input", value: v.text ?? null } },
          emoji: { emoji: { type: "plain_text_input", value: v.emoji ?? null } },
        },
      },
    },
  };
}

function undoValue(blocks: Block[]): string | undefined {
  const act = blocks.find((b) => b.type === "actions");
  const el = act?.type === "actions" ? act.elements[0] : undefined;
  return el?.type === "button" && el.action_id === UNDO_ACTION ? el.value : undefined;
}

describe("/ooo", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    deps = testDeps();
    app = createApp(deps);
  });

  it("rejects an unsigned request", async () => {
    const res = await app.request("/slack/commands", { method: "POST", body: "command=%2Fooo" });
    expect(res.status).toBe(401);
  });

  it("answers health", async () => {
    const res = await app.request("/health");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("opens the status form with the response_url tucked in", async () => {
    await seedWorkspace(deps);
    const res = await slackPost(app, "/slack/commands", {
      command: "/ooo", text: "", team_id: "T1", user_id: "U_DANA", user_name: "dana", trigger_id: "trig-1", response_url: RESPONSE_URL,
    });
    expect(res.status).toBe(200);
    expect(deps.slack.openedViews).toHaveLength(1);
    const opened = deps.slack.openedViews[0];
    expect(opened?.triggerId).toBe("trig-1");
    expect(opened?.view.callback_id).toBe(STATUS_MODAL_CALLBACK);
    expect(JSON.parse(opened?.view.private_metadata ?? "{}")).toEqual({ responseUrl: RESPONSE_URL });
  });

  it("saves a status, sets Slack, sends a receipt with Undo, and Undo clears it", async () => {
    await seedWorkspace(deps);
    const save = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-17" })),
    });
    expect(await save.json()).toEqual({ response_action: "clear" });
    expect(deps.slack.statuses.get("xoxp-dana")).toEqual({
      text: "Out of office", emoji: ":palm_tree:", expiration: zonedTimeToEpochMs("2026-11-18", "00:00", TZ) / 1000,
    });
    const receipt = deps.slack.responses[0];
    expect(receipt?.responseUrl).toBe(RESPONSE_URL);
    expect(receipt?.text).toMatch(/^Out of office · /);
    expect(JSON.stringify(receipt?.blocks)).toContain("✅ Slack status set");
    const statusId = undoValue(receipt?.blocks ?? []);
    expect(statusId).toBeTruthy();

    const undo = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify({
        type: "block_actions", team: { id: "T1" }, user: { id: "U_DANA", username: "dana" }, response_url: RESPONSE_URL,
        actions: [{ action_id: UNDO_ACTION, value: statusId }],
      }),
    });
    expect(undo.status).toBe(200);
    expect(deps.slack.statuses.get("xoxp-dana")).toBeNull();
    const replaced = deps.slack.responses[1];
    expect(replaced?.replaceOriginal).toBe(true);
    expect(replaced?.text).toMatch(/^Undone · Out of office/);
    expect(JSON.stringify(replaced?.blocks)).toContain("↩️ Slack status cleared");
  });

  it("says plainly when Slack isn't connected for the person", async () => {
    await seedWorkspace(deps, { withUserToken: false });
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "sick", from: "2026-11-12", to: "2026-11-12" })),
    });
    expect(deps.slack.statuses.size).toBe(0);
    expect(JSON.stringify(deps.slack.responses[0]?.blocks)).toContain("➖ Slack status skipped — Slack isn't connected");
  });

  it("returns field errors to the form instead of saving", async () => {
    await seedWorkspace(deps);
    const res = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-11" })),
    });
    expect(await res.json()).toEqual({
      response_action: "errors", errors: { to: "The last day can't be before the first" },
    });
    expect(deps.slack.responses).toHaveLength(0);
  });

  it("refuses Undo after five minutes with a plain message", async () => {
    await seedWorkspace(deps);
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-12" })),
    });
    const statusId = undoValue(deps.slack.responses[0]?.blocks ?? []);
    deps.clock.now = NOW + 6 * 60 * 1000;
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify({
        type: "block_actions", team: { id: "T1" }, user: { id: "U_DANA" }, response_url: RESPONSE_URL,
        actions: [{ action_id: UNDO_ACTION, value: statusId }],
      }),
    }, deps.clock.now);
    expect(deps.slack.responses[1]?.text).toBe("The five-minute undo window has passed.");
    expect(deps.slack.statuses.get("xoxp-dana")).not.toBeNull();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm exec vitest run apps/worker`
Expected: FAIL — `Failed to resolve import "../src/app"`.

- [ ] **Step 5: Routes and app**

`apps/worker/src/routes/slack.ts`:
```ts
import {
  STATUS_MODAL_CALLBACK,
  SlackStatusConnector,
  UNDO_ACTION,
  buildStatusModal,
  readStatusSubmission,
  resultCard,
  saveStatus,
  todayIn,
  undoStatus,
} from "@steward/availability";
import { ConnectorRegistry, ensurePerson, getWorkspace, open, verifySlackSignature } from "@steward/core";
import { Hono } from "hono";
import type { Deps } from "../deps";
import type { BlockActionsPayload, InteractionPayload, ViewSubmissionPayload } from "../slackTypes";

type Vars = { Variables: { rawBody: string } };

export function slackRoutes(deps: Deps) {
  const r = new Hono<Vars>();

  // Every Slack request is verified before anything else; the raw body is kept for the handlers.
  r.use("*", async (c, next) => {
    const raw = await c.req.text();
    const ok = await verifySlackSignature({
      secret: deps.signingSecret,
      timestamp: c.req.header("x-slack-request-timestamp") ?? "",
      signature: c.req.header("x-slack-signature") ?? "",
      body: raw,
      nowSeconds: Math.floor(deps.now() / 1000),
    });
    if (!ok) return c.text("invalid signature", 401);
    c.set("rawBody", raw);
    await next();
  });

  r.post("/commands", async (c) => {
    const form = new URLSearchParams(c.get("rawBody"));
    if (form.get("command") !== "/ooo") return c.text("");
    const workspace = await getWorkspace(deps.db, form.get("team_id") ?? "");
    if (!workspace) return c.text("Steward isn't installed in this workspace yet.");
    const userId = form.get("user_id") ?? "";
    const person = await ensurePerson(deps.db, workspace.id, userId, form.get("user_name") ?? userId);
    const botToken = await open(deps.tokenKey, workspace.botTokenSealed);
    await deps.slack.openView({
      botToken,
      triggerId: form.get("trigger_id") ?? "",
      view: buildStatusModal({ today: todayIn(person.tz, deps.now()), responseUrl: form.get("response_url") ?? "" }),
    });
    return c.text("");
  });

  r.post("/interactions", async (c) => {
    const payload = JSON.parse(new URLSearchParams(c.get("rawBody")).get("payload") ?? "{}") as InteractionPayload;
    const workspace = await getWorkspace(deps.db, payload.team?.id ?? "");
    if (!workspace) return c.text("");
    const person = await ensurePerson(
      deps.db,
      workspace.id,
      payload.user.id,
      payload.user.username ?? payload.user.name ?? payload.user.id,
    );
    const userToken = person.userTokenSealed ? await open(deps.tokenKey, person.userTokenSealed) : null;
    const availability = {
      db: deps.db,
      registry: new ConnectorRegistry().register(new SlackStatusConnector(deps.slack)),
      now: deps.now,
    };

    if (payload.type === "view_submission") {
      const { view } = payload as ViewSubmissionPayload;
      if (view.callback_id !== STATUS_MODAL_CALLBACK) return c.text("");
      const read = readStatusSubmission(view);
      if (!read.ok) return c.json({ response_action: "errors", errors: read.errors });
      const saved = await saveStatus(availability, person, read.input, userToken);
      const card = resultCard({ ...saved, tz: person.tz, now: deps.now() });
      if (read.meta.responseUrl) await deps.slack.respond({ responseUrl: read.meta.responseUrl, ...card });
      return c.json({ response_action: "clear" });
    }

    if (payload.type === "block_actions") {
      const { actions, response_url } = payload as BlockActionsPayload;
      const action = actions[0];
      if (action?.action_id === UNDO_ACTION && action.value && response_url) {
        const result = await undoStatus(availability, action.value, person, userToken);
        if ("error" in result) {
          await deps.slack.respond({ responseUrl: response_url, text: result.error });
        } else {
          const card = resultCard({ ...result, tz: person.tz, now: deps.now() });
          await deps.slack.respond({ responseUrl: response_url, ...card, replaceOriginal: true });
        }
      }
      return c.text("");
    }

    return c.text("");
  });

  return r;
}
```

`apps/worker/src/app.ts`:
```ts
import { Hono } from "hono";
import type { Deps } from "./deps";
import { slackRoutes } from "./routes/slack";

export function createApp(deps: Deps) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/slack", slackRoutes(deps));
  return app;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm exec vitest run apps/worker && pnpm exec tsc --noEmit -p apps/worker`
Expected: 7 tests PASS; tsc silent.

- [ ] **Step 7: Commit**

```bash
git add apps/worker pnpm-lock.yaml
git commit -m "feat(worker): /ooo form, save with receipt and Undo over the Slack HTTP surface

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Slack install flow (OAuth v2)

**Files:**
- Create: `apps/worker/src/routes/oauth.ts`
- Modify: `apps/worker/src/app.ts`
- Test: `apps/worker/test/oauth.test.ts`

**Interfaces:**
- Consumes: `Deps` (Task 8), `seal`, `upsertWorkspace`, `ensurePerson`, `setPersonUserToken`, `slackSignature`, `timingSafeEqual` (core).
- Produces: `GET /oauth/slack/install` (302 to Slack), `GET /oauth/slack/callback?code&state`; `BOT_SCOPES`, `USER_SCOPES`, `signState(secret, issuedAtSeconds)`, `verifyState(secret, state, nowSeconds)`.

- [ ] **Step 1: Failing tests**

`apps/worker/test/oauth.test.ts`:
```ts
import { getPerson, getWorkspace, open } from "@steward/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { signState } from "../src/routes/oauth";
import { NOW, SIGNING_SECRET, testDeps } from "./helpers";

describe("Slack install", () => {
  it("redirects to Slack with scopes, redirect_uri and a signed state", async () => {
    const deps = testDeps();
    const res = await createApp(deps).request("/oauth/slack/install");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("scope")).toBe("commands,chat:write,users:read");
    expect(url.searchParams.get("user_scope")).toBe("users.profile:write");
    expect(url.searchParams.get("redirect_uri")).toBe("https://steward.example/oauth/slack/callback");
    expect(url.searchParams.get("state")).toMatch(/^\d+\.[0-9a-f]{64}$/);
  });

  it("rejects a callback with a bad or expired state", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    expect((await app.request("/oauth/slack/callback?code=c&state=1.deadbeef")).status).toBe(400);
    const old = await signState(SIGNING_SECRET, Math.floor(NOW / 1000) - 3600);
    expect((await app.request(`/oauth/slack/callback?code=c&state=${old}`)).status).toBe(400);
  });

  it("exchanges the code, stores sealed tokens for the workspace and the installer", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          access_token: "xoxb-new-bot",
          bot_user_id: "UBOT",
          team: { id: "T9", name: "Acme & Sons" },
          authed_user: { id: "U_OWNER", access_token: "xoxp-owner" },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const deps = testDeps({ fetchFn });
    const state = await signState(SIGNING_SECRET, Math.floor(NOW / 1000));
    const res = await createApp(deps).request(`/oauth/slack/callback?code=the-code&state=${state}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Acme &amp; Sons");

    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("https://slack.com/api/oauth.v2.access");
    expect(new URLSearchParams(call[1].body as string).get("code")).toBe("the-code");

    const ws = await getWorkspace(deps.db, "T9");
    expect(ws?.name).toBe("Acme & Sons");
    expect(ws && (await open(deps.tokenKey, ws.botTokenSealed))).toBe("xoxb-new-bot");
    const owner = await getPerson(deps.db, "T9:U_OWNER");
    expect(owner?.userTokenSealed && (await open(deps.tokenKey, owner.userTokenSealed))).toBe("xoxp-owner");
  });

  it("reports Slack's error plainly when the exchange fails", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_code" }), { headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    const deps = testDeps({ fetchFn });
    const state = await signState(SIGNING_SECRET, Math.floor(NOW / 1000));
    const res = await createApp(deps).request(`/oauth/slack/callback?code=bad&state=${state}`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("invalid_code");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/worker/test/oauth.test.ts`
Expected: FAIL — `Failed to resolve import "../src/routes/oauth"`.

- [ ] **Step 3: Implement**

`apps/worker/src/routes/oauth.ts`:
```ts
import { ensurePerson, seal, setPersonUserToken, slackSignature, timingSafeEqual, upsertWorkspace } from "@steward/core";
import { Hono } from "hono";
import type { Deps } from "../deps";

export const BOT_SCOPES = ["commands", "chat:write", "users:read"];
export const USER_SCOPES = ["users.profile:write"];
const STATE_MAX_AGE_SECONDS = 600;

/** `<issuedAt>.<hmac>` — the HMAC reuses the Slack signing secret so no extra secret is needed. */
export async function signState(secret: string, issuedAtSeconds: number): Promise<string> {
  const mac = await slackSignature(secret, String(issuedAtSeconds), "install");
  return `${issuedAtSeconds}.${mac.slice(3)}`;
}

export async function verifyState(secret: string, state: string, nowSeconds: number): Promise<boolean> {
  const [ts, mac] = state.split(".");
  if (!ts || !mac) return false;
  const issued = Number(ts);
  if (!Number.isFinite(issued) || nowSeconds - issued > STATE_MAX_AGE_SECONDS || issued > nowSeconds + 60) return false;
  const expected = (await slackSignature(secret, ts, "install")).slice(3);
  return timingSafeEqual(expected, mac);
}

type AccessResponse = {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  team?: { id: string; name: string };
  authed_user?: { id: string; access_token?: string };
};

function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (ch) => map[ch] ?? ch);
}

export function oauthRoutes(deps: Deps) {
  const r = new Hono();
  const redirectUri = `${deps.appUrl}/oauth/slack/callback`;

  r.get("/slack/install", async (c) => {
    const state = await signState(deps.signingSecret, Math.floor(deps.now() / 1000));
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", deps.slackClientId);
    url.searchParams.set("scope", BOT_SCOPES.join(","));
    url.searchParams.set("user_scope", USER_SCOPES.join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  r.get("/slack/callback", async (c) => {
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    if (!code || !(await verifyState(deps.signingSecret, state, Math.floor(deps.now() / 1000)))) {
      return c.text("This install link has expired. Start again from the product page.", 400);
    }
    const res = await deps.fetchFn("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: deps.slackClientId,
        client_secret: deps.slackClientSecret,
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    const data = (await res.json()) as AccessResponse;
    if (!data.ok || !data.access_token || !data.team || !data.bot_user_id) {
      return c.text(`Slack didn't complete the install (${data.error ?? "unknown_error"}).`, 502);
    }
    await upsertWorkspace(deps.db, {
      id: data.team.id,
      name: data.team.name,
      botTokenSealed: await seal(deps.tokenKey, data.access_token),
      botUserId: data.bot_user_id,
      installedAt: deps.now(),
    });
    if (data.authed_user) {
      const person = await ensurePerson(deps.db, data.team.id, data.authed_user.id, data.authed_user.id);
      if (data.authed_user.access_token) {
        await setPersonUserToken(deps.db, person.id, await seal(deps.tokenKey, data.authed_user.access_token));
      }
    }
    return c.html(
      `<!doctype html><title>Steward installed</title><p>Steward is installed in <b>${escapeHtml(data.team.name)}</b>. Back in Slack, type <code>/ooo</code>.</p>`,
    );
  });

  return r;
}
```

Modify `apps/worker/src/app.ts` to:
```ts
import { Hono } from "hono";
import type { Deps } from "./deps";
import { oauthRoutes } from "./routes/oauth";
import { slackRoutes } from "./routes/slack";

export function createApp(deps: Deps) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/slack", slackRoutes(deps));
  app.route("/oauth", oauthRoutes(deps));
  return app;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run apps/worker && pnpm exec tsc --noEmit -p apps/worker`
Expected: 11 tests PASS; tsc silent.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): Slack install flow with signed state and sealed tokens

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Worker entry, the minute tick, Wrangler config, local dev and CI build

**Files:**
- Create: `apps/worker/src/tick.ts`, `apps/worker/src/index.ts`, `apps/worker/wrangler.toml`, `apps/worker/.dev.vars.example`
- Test: `apps/worker/test/tick.test.ts`
- Modify: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: `createApp`, `depsFromEnv`, `Env`.
- Produces: `runTick(deps): Promise<{ undoWindowsExpired: number }>`, `expireUndoWindows(deps)`; the Worker's default export with `fetch` and `scheduled`.

- [ ] **Step 1: Failing tick test**

`apps/worker/test/tick.test.ts`:
```ts
import { schema } from "@steward/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runTick } from "../src/tick";
import { NOW, testDeps } from "./helpers";

describe("tick", () => {
  it("closes undo windows that have passed and leaves open ones alone", async () => {
    const deps = testDeps();
    const base = {
      workspaceId: "T1", personId: "T1:U1", type: "out", startMs: 0, endMs: 1, text: "x", emoji: ":x:",
      state: "active", source: "form", createdAt: 0, replacedStatusId: null,
    };
    await deps.db.insert(schema.statuses).values([
      { ...base, id: "old", undoUntilMs: NOW - 1 },
      { ...base, id: "fresh", undoUntilMs: NOW + 60_000 },
      { ...base, id: "none", undoUntilMs: null },
    ]);
    expect(await runTick(deps)).toEqual({ undoWindowsExpired: 1 });
    const old = await deps.db.select().from(schema.statuses).where(eq(schema.statuses.id, "old"));
    const fresh = await deps.db.select().from(schema.statuses).where(eq(schema.statuses.id, "fresh"));
    expect(old[0]?.undoUntilMs).toBeNull();
    expect(fresh[0]?.undoUntilMs).toBe(NOW + 60_000);
    expect(await runTick(deps)).toEqual({ undoWindowsExpired: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/worker/test/tick.test.ts`
Expected: FAIL — `Failed to resolve import "../src/tick"`.

- [ ] **Step 3: Implement tick and entry**

`apps/worker/src/tick.ts`:
```ts
import { schema } from "@steward/core";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { Deps } from "./deps";

/** Undo windows that have passed are closed so the card stops offering Undo. */
export async function expireUndoWindows(deps: Pick<Deps, "db" | "now">): Promise<number> {
  const now = deps.now();
  const due = await deps.db
    .select({ id: schema.statuses.id })
    .from(schema.statuses)
    .where(and(isNotNull(schema.statuses.undoUntilMs), lt(schema.statuses.undoUntilMs, now)));
  for (const row of due) {
    await deps.db.update(schema.statuses).set({ undoUntilMs: null }).where(eq(schema.statuses.id, row.id));
  }
  return due.length;
}

/** Runs once a minute from the cron trigger. Plan 3 adds scheduled fires, asks and retries here. */
export async function runTick(deps: Pick<Deps, "db" | "now">): Promise<{ undoWindowsExpired: number }> {
  return { undoWindowsExpired: await expireUndoWindows(deps) };
}
```

`apps/worker/src/index.ts`:
```ts
import { createApp } from "./app";
import { depsFromEnv } from "./deps";
import type { Env } from "./env";
import { runTick } from "./tick";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return createApp(depsFromEnv(env)).fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runTick(depsFromEnv(env)));
  },
} satisfies ExportedHandler<Env>;
```

`apps/worker/wrangler.toml`:
```toml
name = "steward"
main = "src/index.ts"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]

# Replace database_id after `pnpm --filter @steward/worker exec wrangler d1 create steward`
# (needs the Cloudflare account the owner creates; any id works for `wrangler dev` locally).
[[d1_databases]]
binding = "DB"
database_name = "steward"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "../../packages/core/drizzle"

[triggers]
crons = ["* * * * *"]

[vars]
APP_URL = "http://localhost:8787"
SLACK_CLIENT_ID = "set-in-dev-vars-or-dashboard"
```

`apps/worker/.dev.vars.example`:
```
# Copy to .dev.vars for `wrangler dev`. Never commit .dev.vars.
SLACK_SIGNING_SECRET=from the Slack app's Basic Information page
SLACK_CLIENT_ID=from the Slack app's Basic Information page
SLACK_CLIENT_SECRET=from the Slack app's Basic Information page
TOKEN_KEY=run: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
APP_URL=http://localhost:8787
```

- [ ] **Step 4: Run tests and the dry-run build**

Run: `pnpm exec vitest run apps/worker && pnpm exec tsc --noEmit -p apps/worker && pnpm --filter @steward/worker build`
Expected: 12 tests PASS; tsc silent; Wrangler prints `--dry-run: exiting now.` after bundling to `apps/worker/dist` with no errors.

- [ ] **Step 5: CI build step and README**

Append to the `steps` in `.github/workflows/ci.yml`:
```yaml
      - run: pnpm --filter @steward/worker build
```

Replace the "Status" paragraph in `README.md` with:
```markdown
Status: Plan 1 (core and the first door) built — `/ooo` form → Slack status → receipt → Undo, install flow, minute tick. The design is in [`docs/superpowers/specs/2026-11-08-steward-availability-design.md`](docs/superpowers/specs/2026-11-08-steward-availability-design.md); plans live in `docs/superpowers/plans/`.

## Develop

```bash
pnpm install
pnpm test                                   # unit + flow tests (Node, in-memory SQLite, fake Slack)
pnpm --filter @steward/worker db:migrate:local
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # then fill in the values
pnpm --filter @steward/worker dev           # http://localhost:8787/health
```
```

- [ ] **Step 6: Lint, full test run, commit**

Run: `pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test`
Expected: everything green.

```bash
git add -A
git commit -m "feat(worker): entry point, minute tick, Wrangler config, local dev and CI build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage (Plan 1 scope = spec §12 week 1):** repository and Worker skeleton — Tasks 1, 8, 10; D1 schema and migrations — Task 4; Slack install flow — Task 9; the engine with fake connectors — Tasks 5, 6, 7; `/ooo` form → Slack status write → receipt → Undo — Tasks 7, 8; the demo session and the first emulator — **deliberately moved to Plan 2** so this plan ends with a tested, deployable Worker. Spec §3 principles: parse-then-review is the form itself (nothing saves before Save; plain words arrive in Plan 3); act only on a yes (Save/Undo taps); receipts and Undo (card from target rows, five-minute window, tick closes it); honest states (five target states, worded lines); one save path (`saveStatus` is the only writer). Spec §10 security: signature verification (Task 2, 8), signed OAuth state (Task 9), AES-GCM tokens (Task 3), audit rows (Task 6), per-workspace scoping (all queries carry `workspaceId` or go through a person row that does).

**Placeholder scan:** the only configuration value left for the owner is `database_id` in `wrangler.toml`, with the exact command that produces it; no "TBD"/"TODO"; every code step shows the code.

**Type consistency:** `StatusRow` and `TargetRow` come from `schema.ts` and are used unchanged in `card.ts`, `service.ts` and the tests; `saveStatus`/`undoStatus` signatures `(deps, person, input, userToken)` / `(deps, statusId, person, userToken)` match the route; `UNDO_ACTION`, `STATUS_MODAL_CALLBACK`, `SLACK_STATUS` are defined once and imported everywhere else; `Deps.fetchFn` is used by the OAuth route and overridden in its test; `FakeSlackClient.statuses` is keyed by user token in the connector (`xoxp-dana`) and in every assertion.

