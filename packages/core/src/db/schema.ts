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
    /** When the display name and tz were last read from Slack; after a failed or empty read it is back-dated so the next attempt is an hour away (see personForSlackUser). Null until the first read. */
    profileSyncedAt: integer("profile_synced_at"),
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

/** A visitor's hour in the demo. `id` is random; the workspace it owns is `demo:<id>`. */
export const demoSessions = sqliteTable("demo_sessions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  /** Added to the real clock for every request in this session (the emulator's "advance time"). */
  clockOffsetMs: integer("clock_offset_ms").notNull().default(0),
  youPersonId: text("you_person_id").notNull(),
});

/** Everything the fake Slack was asked to do, in order: `view` (views.open), `response` (response_url post), `status` (profile status set or cleared). */
export const demoEvents = sqliteTable(
  "demo_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [index("demo_events_session_seq_idx").on(t.sessionId, t.seq)],
);

export type DemoSessionRow = typeof demoSessions.$inferSelect;
export type DemoEventRow = typeof demoEvents.$inferSelect;
