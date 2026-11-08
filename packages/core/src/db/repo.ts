import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { type PersonRow, people, type WorkspaceRow, workspaces } from "./schema";

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
    profileSyncedAt: null,
  };
  await db.insert(people).values(row).onConflictDoNothing();
  return (await getPerson(db, id)) ?? row;
}

export async function setPersonUserToken(db: Db, id: string, sealed: string): Promise<PersonRow> {
  await db.update(people).set({ userTokenSealed: sealed }).where(eq(people.id, id));
  const row = await getPerson(db, id);
  if (!row) throw new Error(`person ${id} not found`);
  return row;
}

export async function updatePersonProfile(
  db: Db,
  id: string,
  profile: { displayName: string; tz: string; profileSyncedAt: number },
): Promise<PersonRow> {
  await db.update(people).set(profile).where(eq(people.id, id));
  const row = await getPerson(db, id);
  if (!row) throw new Error(`person ${id} not found`);
  return row;
}
