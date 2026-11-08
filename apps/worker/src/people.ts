import {
  ensurePerson,
  open,
  type PersonRow,
  updatePersonProfile,
  type WorkspaceRow,
} from "@steward/core";
import type { Deps } from "./deps";

/** How long a person's Slack profile (time zone, display name) is trusted before it is read again. */
export const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The person row for a Slack user. Their time zone and display name are read from Slack on first
 * contact and refreshed once a day; a failed or empty read keeps what is stored.
 */
export async function personForSlackUser(
  deps: Deps,
  workspace: WorkspaceRow,
  slackUserId: string,
  fallbackName: string,
): Promise<PersonRow> {
  const person = await ensurePerson(deps.db, workspace.id, slackUserId, fallbackName);
  const now = deps.now();
  if (person.profileSyncedAt !== null && now - person.profileSyncedAt < PROFILE_MAX_AGE_MS) {
    return person;
  }
  try {
    const botToken = await open(deps.tokenKey, workspace.botTokenSealed);
    const profile = await deps.slack.getUserInfo({ botToken, userId: slackUserId });
    if (!profile) return person;
    return await updatePersonProfile(deps.db, person.id, { ...profile, profileSyncedAt: now });
  } catch (err) {
    console.error("users.info failed; keeping the stored profile", { person: person.id, err });
    return person;
  }
}
