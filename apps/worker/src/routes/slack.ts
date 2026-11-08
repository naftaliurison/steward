import {
  buildStatusModal,
  readStatusSubmission,
  resultCard,
  SlackStatusConnector,
  STATUS_MODAL_CALLBACK,
  saveStatus,
  todayIn,
  UNDO_ACTION,
  undoStatus,
} from "@steward/availability";
import {
  ConnectorRegistry,
  getWorkspace,
  open,
  type PersonRow,
  verifySlackSignature,
} from "@steward/core";
import { Hono } from "hono";
import type { Deps } from "../deps";
import { personForSlackUser } from "../people";
import type { BlockActionsPayload, InteractionPayload, ViewSubmissionPayload } from "../slackTypes";

export const SAVE_FAILED = "Your status didn't save. Please try again in a moment.";
export const UNDO_FAILED = "Undo didn't go through. Please try again in a moment.";
export const LOOKUP_FAILED = "Steward couldn't reach its records. Please try again in a moment.";
const BOT_TOKEN_UNREADABLE =
  "Steward can't reach Slack for this workspace right now. Ask whoever installed it to reinstall Steward.";

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
    let botToken: string;
    try {
      botToken = await open(deps.tokenKey, workspace.botTokenSealed);
    } catch (err) {
      console.error("bot token unreadable", { workspace: workspace.id, err });
      return c.text(BOT_TOKEN_UNREADABLE);
    }
    try {
      const person = await personForSlackUser(
        deps,
        workspace,
        userId,
        form.get("user_name") ?? userId,
      );
      await deps.slack.openView({
        botToken,
        triggerId: form.get("trigger_id") ?? "",
        view: buildStatusModal({
          today: todayIn(person.tz, deps.now()),
          responseUrl: form.get("response_url") ?? "",
        }),
      });
    } catch (err) {
      console.error("could not open the status form", { workspace: workspace.id, err });
      return c.text("Steward couldn't open the form just now. Please try /ooo again.");
    }
    return c.text("");
  });

  r.post("/interactions", async (c) => {
    let payload: InteractionPayload;
    try {
      payload = JSON.parse(
        new URLSearchParams(c.get("rawBody")).get("payload") ?? "",
      ) as InteractionPayload;
    } catch {
      return c.text(""); // not a Slack payload; nothing to act on
    }
    if (!payload || typeof payload !== "object" || !payload.team?.id || !payload.user?.id)
      return c.text("");
    const workspace = await getWorkspace(deps.db, payload.team?.id ?? "");
    if (!workspace) return c.text("");
    const availability = {
      db: deps.db,
      registry: new ConnectorRegistry().register(new SlackStatusConnector(deps.slack)),
      now: deps.now,
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
      if (view.callback_id !== STATUS_MODAL_CALLBACK) return c.text("");
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
        return c.json({
          response_action: "errors",
          errors: { type: LOOKUP_FAILED },
        });
      }
      const read = readStatusSubmission(view, { today: todayIn(person.tz, deps.now()) });
      if (!read.ok) return c.json({ response_action: "errors", errors: read.errors });
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
      return c.json({ response_action: "clear" });
    }

    if (payload.type === "block_actions") {
      const { actions, response_url } = payload as BlockActionsPayload;
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
      return c.text("");
    }

    return c.text("");
  });

  return r;
}
