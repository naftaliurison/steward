import {
  type ActorCtx,
  type ConnectorRegistry,
  createTargets,
  type Db,
  executeTargets,
  newId,
  type PersonRow,
  type StatusRow,
  schema,
  type TargetRow,
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

function ctxFor(person: PersonRow, userToken: string | null): ActorCtx {
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
    await deps.db
      .update(schema.statuses)
      .set({ state: "ended" })
      .where(eq(schema.statuses.id, previous.id));
  }
  await deps.db.insert(schema.statuses).values(status);
  let targets = await createTargets(deps.db, status.id, planWrites(input, { startMs, endMs }));
  if (status.state === "active") {
    targets = await executeTargets(
      deps.db,
      deps.registry,
      ctxFor(person, userToken),
      targets,
      deps.now,
    );
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
  if (!status || status.personId !== person.id)
    return { error: "That status isn't yours or no longer exists." };
  if (status.state === "cancelled")
    return { status, targets: await targetsForStatus(deps.db, status.id) };
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
