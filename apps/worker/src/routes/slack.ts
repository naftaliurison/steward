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
import { ConnectorRegistry, getWorkspace, open, verifySlackSignature } from "@steward/core";
import { Hono } from "hono";
import type { Deps } from "../deps";
import { personForSlackUser } from "../people";
import type { BlockActionsPayload, InteractionPayload, ViewSubmissionPayload } from "../slackTypes";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
    const person = await personForSlackUser(
      deps,
      workspace,
      userId,
      form.get("user_name") ?? userId,
    );
    const botToken = await open(deps.tokenKey, workspace.botTokenSealed);
    await deps.slack.openView({
      botToken,
      triggerId: form.get("trigger_id") ?? "",
      view: buildStatusModal({
        today: todayIn(person.tz, deps.now()),
        responseUrl: form.get("response_url") ?? "",
      }),
    });
    return c.text("");
  });

  r.post("/interactions", async (c) => {
    const payload = JSON.parse(
      new URLSearchParams(c.get("rawBody")).get("payload") ?? "{}",
    ) as InteractionPayload;
    const workspace = await getWorkspace(deps.db, payload.team?.id ?? "");
    if (!workspace) return c.text("");
    const availability = {
      db: deps.db,
      registry: new ConnectorRegistry().register(new SlackStatusConnector(deps.slack)),
      now: deps.now,
    };
    const personAndToken = async () => {
      const person = await personForSlackUser(
        deps,
        workspace,
        payload.user.id,
        payload.user.username ?? payload.user.name ?? payload.user.id,
      );
      const userToken = person.userTokenSealed
        ? await open(deps.tokenKey, person.userTokenSealed)
        : null;
      return { person, userToken };
    };
    // Slack wants view_submission and block_actions answered within 3 seconds, so the work runs after the answer.
    const tellUser = async (responseUrl: string | undefined, text: string) => {
      if (!responseUrl) return;
      try {
        await deps.slack.respond({ responseUrl, text });
      } catch {
        // Nothing left to tell the user through.
      }
    };

    if (payload.type === "view_submission") {
      const { view } = payload as ViewSubmissionPayload;
      if (view.callback_id !== STATUS_MODAL_CALLBACK) return c.text("");
      // "Today" is the person's, not UTC's, so the person is resolved before validation. The user token is not.
      const person = await personForSlackUser(
        deps,
        workspace,
        payload.user.id,
        payload.user.username ?? payload.user.name ?? payload.user.id,
      );
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
            await tellUser(
              responseUrl,
              `Your status didn't save — ${errorMessage(err)}. Please try again.`,
            );
            return;
          }
          try {
            if (responseUrl) {
              const card = resultCard({ ...saved, tz: person.tz, now: deps.now() });
              await deps.slack.respond({ responseUrl, ...card });
            }
          } catch {
            // The status is saved; a lost receipt is not worth a misleading message.
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
            let person: Awaited<ReturnType<typeof personAndToken>>["person"];
            let result: Awaited<ReturnType<typeof undoStatus>>;
            try {
              const pt = await personAndToken();
              person = pt.person;
              result = await undoStatus(availability, statusId, person, pt.userToken);
            } catch (err) {
              await tellUser(response_url, `Undo didn't go through — ${errorMessage(err)}.`);
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
            } catch {
              // The undo went through; a lost receipt is not worth a misleading message.
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
