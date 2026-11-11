import { eq } from "drizzle-orm";
import type { Db } from "./client";
import {
  type GoogleConnectionRow,
  googleConnections,
  type PersonRow,
  people,
  type WorkspaceRow,
  workspaces,
} from "./schema";

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
