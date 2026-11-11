import {
  buildStatusModal,
  readStatusSubmission,
  resultCard,
  STATUS_MODAL_CALLBACK,
  saveStatus,
  scheduledStatusesFor,
  todayIn,
  UNDO_ACTION,
  undoStatus,
} from "@steward/availability";
import { getWorkspace, open, type PersonRow, targetsForStatus } from "@steward/core";
import type { Deps } from "../deps";
import { personForSlackUser } from "../people";
import { googleConfigured, registryFor } from "../registry";
import type { BlockActionsPayload, InteractionPayload, ViewSubmissionPayload } from "../slackTypes";
import { googleCommandOf, googleDisconnectText, googleStatusText } from "./googleCommand";

export const SAVE_FAILED = "Your status didn't save. Please try again in a moment.";
export const UNDO_FAILED = "Undo didn't go through. Please try again in a moment.";
export const LOOKUP_FAILED = "Steward couldn't reach its records. Please try again in a moment.";
const BOT_TOKEN_UNREADABLE =
  "Steward can't reach Slack for this workspace right now. Ask whoever installed it to reinstall Steward.";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** What the HTTP route must answer Slack with. */
export type InteractionAnswer = { kind: "json"; body: unknown } | { kind: "text"; body: string };

/** How many scheduled statuses /ooo shows. Slack takes five messages on one response_url. */
export const SCHEDULED_SHOWN = 3;

/** One card per status that has not started yet, each with its own Cancel. Never throws: the form is already open. */
async function showScheduled(deps: Deps, person: PersonRow, responseUrl: string): Promise<void> {
  try {
    const scheduled = await scheduledStatusesFor(deps.db, person.id, SCHEDULED_SHOWN);
    for (const status of scheduled) {
      const card = resultCard({
        status,
        targets: await targetsForStatus(deps.db, status.id),
        tz: person.tz,
        now: deps.now(),
      });
      await deps.slack.respond({ responseUrl, ...card });
    }
  } catch (err) {
    console.error("could not show scheduled statuses", { person: person.id, err });
  }
}

/** The slash-command handler. Returns the text Slack shows the caller at once ("" for nothing). */
export async function handleSlashCommand(deps: Deps, form: URLSearchParams): Promise<string> {
  if (form.get("command") !== "/ooo") return "";
  const workspace = await getWorkspace(deps.db, form.get("team_id") ?? "");
  if (!workspace) return "Steward isn't installed in this workspace yet.";
  const userId = form.get("user_id") ?? "";
  let botToken: string;
  try {
    botToken = await open(deps.tokenKey, workspace.botTokenSealed);
  } catch (err) {
    console.error("bot token unreadable", { workspace: workspace.id, err });
    return BOT_TOKEN_UNREADABLE;
  }
  try {
    const person = await personForSlackUser(
      deps,
      workspace,
      userId,
      form.get("user_name") ?? userId,
    );
    // A demo person is never offered Google: the form opens as for plain /ooo.
    const cmd = workspace.id.startsWith("demo:") ? null : googleCommandOf(form.get("text") ?? "");
    if (cmd !== null) {
      try {
        return cmd === "google"
          ? await googleStatusText(deps, person)
          : await googleDisconnectText(deps, person);
      } catch {
        console.error("could not answer /ooo google", { person: person.id });
        return "Steward couldn't do that just now. Please try again.";
      }
    }
    await deps.slack.openView({
      botToken,
      triggerId: form.get("trigger_id") ?? "",
      view: buildStatusModal({
        today: todayIn(person.tz, deps.now()),
        responseUrl: form.get("response_url") ?? "",
      }),
    });
    const responseUrl = form.get("response_url") ?? "";
    if (responseUrl) deps.defer(showScheduled(deps, person, responseUrl));
  } catch (err) {
    console.error("could not open the status form", { workspace: workspace.id, err });
    return "Steward couldn't open the form just now. Please try /ooo again.";
  }
  return "";
}

/** The interaction handler. `rawPayload` is the decoded `payload` form field (a JSON string) or an already-parsed object. */
export async function handleInteraction(
  deps: Deps,
  rawPayload: unknown,
): Promise<InteractionAnswer> {
  let payload: InteractionPayload;
  if (typeof rawPayload === "string") {
    try {
      payload = JSON.parse(rawPayload) as InteractionPayload;
    } catch {
      return { kind: "text", body: "" }; // not a Slack payload; nothing to act on
    }
  } else if (rawPayload !== null && typeof rawPayload === "object") {
    payload = rawPayload as InteractionPayload;
  } else {
    return { kind: "text", body: "" };
  }
  if (!payload || typeof payload !== "object" || !payload.team?.id || !payload.user?.id)
    return { kind: "text", body: "" };
  const workspace = await getWorkspace(deps.db, payload.team?.id ?? "");
  if (!workspace) return { kind: "text", body: "" };
  const availability = {
    db: deps.db,
    registry: registryFor(deps),
    now: deps.now,
    googleHint: googleConfigured(deps) && !workspace.id.startsWith("demo:"),
  };
  // Slack wants view_submission and block_actions answered within 3 seconds, so the work runs after the answer.
  const tellUser = async (responseUrl: string | undefined, text: string) => {
    if (!responseUrl) return;
    try {
      await deps.slack.respond({ responseUrl, text });
    } catch (err) {
      console.error("could not tell the user", { err });
    }
  };

  if (payload.type === "view_submission") {
    const { view } = payload as ViewSubmissionPayload;
    const values: unknown = (view as { state?: { values?: unknown } } | undefined)?.state?.values;
    if (!isObject(view) || !isObject(values)) return { kind: "text", body: "" };
    if (view.callback_id !== STATUS_MODAL_CALLBACK) return { kind: "text", body: "" };
    // "Today" is the person's, not UTC's, so the person is resolved before validation. The user token is not.
    let person: PersonRow;
    try {
      person = await personForSlackUser(
        deps,
        workspace,
        payload.user.id,
        payload.user.username ?? payload.user.name ?? payload.user.id,
      );
    } catch (err) {
      console.error("person lookup failed", { user: payload.user.id, err });
      return {
        kind: "json",
        body: {
          response_action: "errors",
          errors: { type: LOOKUP_FAILED },
        },
      };
    }
    const read = readStatusSubmission(view, { today: todayIn(person.tz, deps.now()) });
    if (!read.ok) return { kind: "json", body: { response_action: "errors", errors: read.errors } };
    const responseUrl = read.meta.responseUrl;
    deps.defer(
      (async () => {
        let saved: Awaited<ReturnType<typeof saveStatus>>;
        try {
          const userToken = person.userTokenSealed
            ? await open(deps.tokenKey, person.userTokenSealed)
            : null;
          saved = await saveStatus(availability, person, read.input, userToken);
        } catch (err) {
          console.error("save failed", { person: person.id, err });
          await tellUser(responseUrl, SAVE_FAILED);
          return;
        }
        try {
          if (responseUrl) {
            const card = resultCard({ ...saved, tz: person.tz, now: deps.now() });
            await deps.slack.respond({ responseUrl, ...card });
          }
        } catch (err) {
          console.error("receipt not delivered", { person: person.id, err });
        }
      })(),
    );
    return { kind: "json", body: { response_action: "clear" } };
  }

  if (payload.type === "block_actions") {
    const { actions, response_url } = payload as BlockActionsPayload;
    if (!Array.isArray(actions)) return { kind: "text", body: "" };
    const action = actions[0];
    if (action?.action_id === UNDO_ACTION && action.value && response_url) {
      const statusId = action.value;
      deps.defer(
        (async () => {
          let person: PersonRow;
          let result: Awaited<ReturnType<typeof undoStatus>>;
          try {
            person = await personForSlackUser(
              deps,
              workspace,
              payload.user.id,
              payload.user.username ?? payload.user.name ?? payload.user.id,
            );
            const userToken = person.userTokenSealed
              ? await open(deps.tokenKey, person.userTokenSealed)
              : null;
            result = await undoStatus(availability, statusId, person, userToken);
          } catch (err) {
            console.error("undo failed", { status: statusId, err });
            await tellUser(response_url, UNDO_FAILED);
            return;
          }
          try {
            if ("error" in result) {
              await deps.slack.respond({ responseUrl: response_url, text: result.error });
            } else {
              const card = resultCard({ ...result, tz: person.tz, now: deps.now() });
              await deps.slack.respond({
                responseUrl: response_url,
                ...card,
                replaceOriginal: true,
              });
            }
          } catch (err) {
            console.error("receipt not delivered", { status: statusId, err });
          }
        })(),
      );
    }
    return { kind: "text", body: "" };
  }

  return { kind: "text", body: "" };
}
