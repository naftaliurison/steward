import {
  type ActorCtx,
  type ConnectorRegistry,
  createTargets,
  type Db,
  executeTargets,
  getGoogleConnection,
  newId,
  type PersonRow,
  type StatusRow,
  schema,
  type TargetRow,
  targetsForStatus,
  undoTargets,
} from "@steward/core";
import { and, asc, eq } from "drizzle-orm";
import { GOOGLE_TYPES, planWrites, writesAtSave } from "./plan";
import { nextDay, zonedTimeToEpochMs } from "./time";
import type { StatusInput } from "./types";

export const UNDO_WINDOW_MS = 5 * 60 * 1000;
/** A write still pending this long after it was due is picked up by the tick. */
export const RECOVERY_DELAY_MS = 2 * 60 * 1000;
export const CANCEL_TOO_LATE =
  "That status has already started — Cancel works only before the first day.";

export const GOOGLE_HINT =
  "Connect Google and Steward will also set your calendar and Gmail auto-reply — run /ooo google";

export type AvailabilityDeps = {
  db: Db;
  registry: ConnectorRegistry;
  now: () => number;
  /** Whether to tell a person without Google that they can connect it. Default false. */
  googleHint?: boolean;
};
export type SaveResult = { status: StatusRow; targets: TargetRow[]; notes: string[] };

function ctxFor(person: PersonRow, userToken: string | null): ActorCtx {
  return { workspaceId: person.workspaceId, personId: person.id, userToken };
}

export async function getStatus(
  db: Db,
  id: string,
  workspaceId: string,
): Promise<StatusRow | null> {
  const rows = await db
    .select()
    .from(schema.statuses)
    .where(and(eq(schema.statuses.id, id), eq(schema.statuses.workspaceId, workspaceId)));
  return rows[0] ?? null;
}

export async function activeStatusFor(db: Db, personId: string): Promise<StatusRow | null> {
  const rows = await db
    .select()
    .from(schema.statuses)
    .where(and(eq(schema.statuses.personId, personId), eq(schema.statuses.state, "active")));
  return rows[0] ?? null;
}

/** The person's statuses that have not started yet, earliest first. */
export async function scheduledStatusesFor(
  db: Db,
  personId: string,
  limit: number,
): Promise<StatusRow[]> {
  return db
    .select()
    .from(schema.statuses)
    .where(and(eq(schema.statuses.personId, personId), eq(schema.statuses.state, "scheduled")))
    .orderBy(asc(schema.statuses.startMs))
    .limit(limit);
}

/**
 * The one save path. All-day statuses in the person's time zone; `endMs` is the midnight after the last day.
 * Active statuses write now; scheduled ones leave their targets pending until the tick starts them.
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
  // Read before anything is written, so a failed read cannot leave a status without targets.
  const wantsGoogle = GOOGLE_TYPES.includes(input.type);
  const google = wantsGoogle ? await getGoogleConnection(deps.db, person.id) : null;
  const state = startMs <= now ? "active" : "scheduled";
  const status: StatusRow = {
    id: newId(),
    workspaceId: person.workspaceId,
    personId: person.id,
    type: input.type,
    startMs,
    endMs,
    text: input.text,
    emoji: input.emoji,
    state,
    source: "form",
    createdAt: now,
    // A scheduled status can be cancelled until it starts; one that starts now can be undone for five minutes.
    undoUntilMs: state === "scheduled" ? startMs : now + UNDO_WINDOW_MS,
    replacedStatusId: state === "active" ? (previous?.id ?? null) : null,
  };
  if (previous && status.state === "active") {
    await deps.db
      .update(schema.statuses)
      .set({ state: "ended" })
      .where(eq(schema.statuses.id, previous.id));
  }
  await deps.db.insert(schema.statuses).values(status);
  const created = await createTargets(
    deps.db,
    status.id,
    planWrites(input, { startMs, endMs }, { tz: person.tz, google }),
    (spec) =>
      // Google accepts future dates, so its writes run now; Slack waits for the start.
      (writesAtSave(spec.system) || state === "active" ? now : startMs) + RECOVERY_DELAY_MS,
  );
  const runNow = state === "active" ? created : created.filter((t) => writesAtSave(t.system));
  const ran =
    runNow.length === 0
      ? []
      : await executeTargets(deps.db, deps.registry, ctxFor(person, userToken), runNow, deps.now);
  const afterRun = new Map(ran.map((t) => [t.id, t]));
  const targets = created.map((t) => afterRun.get(t.id) ?? t);
  const notes = wantsGoogle && !google && deps.googleHint ? [GOOGLE_HINT] : [];
  return { status, targets, notes };
}

/** Reverses every write of the person's own status inside the undo window and marks it cancelled. */
export async function undoStatus(
  deps: AvailabilityDeps,
  statusId: string,
  person: PersonRow,
  userToken: string | null,
): Promise<SaveResult | { error: string }> {
  const status = await getStatus(deps.db, statusId, person.workspaceId);
  if (!status || status.personId !== person.id)
    return { error: "That status isn't yours or no longer exists." };
  if (status.state === "cancelled")
    return { status, targets: await targetsForStatus(deps.db, status.id), notes: [] };
  if (status.undoUntilMs === null || status.undoUntilMs <= deps.now()) {
    // Saved ahead of its first day: what has run out is the time before the start, not five minutes.
    return {
      error:
        status.startMs > status.createdAt
          ? CANCEL_TOO_LATE
          : "The five-minute undo window has passed.",
    };
  }
  if (status.state !== "active" && status.state !== "scheduled") {
    return {
      error: "That status was already replaced by a newer one — undo the newer one instead.",
    };
  }
  const targets = await undoTargets(
    deps.db,
    deps.registry,
    ctxFor(person, userToken),
    await targetsForStatus(deps.db, status.id),
    deps.now,
  );
  // A write that stayed `done` was not reversed: keep the status as it is so the card says so and offers Undo again.
  if (targets.some((t) => t.state === "done")) return { status, targets, notes: [] };
  await deps.db
    .update(schema.statuses)
    .set({ state: "cancelled", undoUntilMs: null })
    .where(eq(schema.statuses.id, status.id));
  return {
    status: { ...status, state: "cancelled", undoUntilMs: null },
    targets,
    notes: [],
  };
}
