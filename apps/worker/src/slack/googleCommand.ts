import { deleteGoogleConnection, getGoogleConnection, open, type PersonRow } from "@steward/core";
import type { Deps } from "../deps";
import { signGoogleState } from "../google/state";
import { googleConfigured } from "../registry";

const NOT_SET_UP = "Google isn't set up for this Steward yet.";

/** What the text after /ooo asks for. Anything else opens the form. */
export function googleCommandOf(text: string): "google" | "disconnect" | null {
  const words = text.trim().toLowerCase().split(/\s+/).join(" ");
  if (words === "google") return "google";
  if (words === "google disconnect") return "disconnect";
  return null;
}

async function connectUrl(deps: Deps, person: PersonRow): Promise<string> {
  const state = await signGoogleState(deps.signingSecret, person.id, Math.floor(deps.now() / 1000));
  return `${deps.appUrl}/oauth/google/start?state=${encodeURIComponent(state)}`;
}

/** Answers `/ooo google`: the private text Slack shows the person. */
export async function googleStatusText(deps: Deps, person: PersonRow): Promise<string> {
  if (!googleConfigured(deps)) return NOT_SET_UP;
  const connection = await getGoogleConnection(deps.db, person.id);
  if (!connection) {
    return `Connect Google and Steward will also set your calendar and Gmail auto-reply: <${await connectUrl(deps, person)}|Connect Google>\nThe link works for ten minutes.`;
  }
  if (connection.health === "ok") {
    const as = connection.email === "" ? "" : ` as ${connection.email}`;
    return `Google is connected${as}. To disconnect, run /ooo google disconnect. To connect a different account: <${await connectUrl(deps, person)}|Connect again>`;
  }
  return `Steward lost its access to Google. <${await connectUrl(deps, person)}|Reconnect Google>\nThe link works for ten minutes.`;
}

/** Answers `/ooo google disconnect`. */
export async function googleDisconnectText(deps: Deps, person: PersonRow): Promise<string> {
  if (!googleConfigured(deps)) return NOT_SET_UP;
  const connection = await getGoogleConnection(deps.db, person.id);
  if (!connection) return "Google isn't connected.";
  let token: string | null = null;
  try {
    token = await open(deps.tokenKey, connection.refreshTokenSealed);
  } catch {
    console.error("could not open the Google refresh token", { person: person.id });
  }
  // The row goes first: whatever happens to the revoke, Steward no longer holds access.
  await deleteGoogleConnection(deps.db, person.id);
  if (token !== null) {
    const refreshToken = token;
    deps.defer(
      deps.google.revokeToken({ token: refreshToken }).catch(() => {
        console.error("could not revoke the Google token", { person: person.id });
      }),
    );
  }
  return "Google is disconnected. Events and auto-replies Steward already set stay as they are.";
}
