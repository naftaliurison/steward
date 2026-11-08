import {
  ensurePerson,
  open,
  type PersonRow,
  type UserProfile,
  updatePersonProfile,
  type WorkspaceRow,
} from "@steward/core";
import type { Deps } from "./deps";

/** How long a person's Slack profile (time zone, display name) is trusted before it is read again. */
export const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** After a failed or empty read, the next attempt waits this long instead of retrying every request. */
export const PROFILE_RETRY_MS = 60 * 60 * 1000;

/**
 * The person row for a Slack user. Their time zone and display name are read from Slack on first
 * contact and refreshed once a day; a failed or empty read keeps what is stored
 * and is retried an hour later.
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
  let profile: UserProfile | null = null;
  try {
    const botToken = await open(deps.tokenKey, workspace.botTokenSealed);
    profile = await deps.slack.getUserInfo({ botToken, userId: slackUserId });
  } catch (err) {
    console.error("users.info failed; keeping the stored profile", { person: person.id, err });
  }
  try {
    return await updatePersonProfile(deps.db, person.id, {
      displayName: profile?.displayName ?? person.displayName,
      tz: profile?.tz ?? person.tz,
      // No profile: a marker that makes the next attempt come PROFILE_RETRY_MS from now.
      profileSyncedAt: profile ? now : now - PROFILE_MAX_AGE_MS + PROFILE_RETRY_MS,
    });
  } catch (err) {
    console.error("profile write failed; keeping the stored profile", { person: person.id, err });
    return person;
  }
}
