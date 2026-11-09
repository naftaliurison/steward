import type { Block } from "@steward/core";
import { describe, expect, it } from "vitest";
import { initialValues } from "../../web/src/blockkit/values";
import { DemoFailed, DemoGone, demoApi } from "../../web/src/demo/api";
import { deriveScreen } from "../../web/src/demo/model";
import { blockAction, viewSubmission } from "../../web/src/demo/payloads";
import { createApp } from "../src/app";
import { testDeps } from "./helpers";

/** The browser's own client and payload builders, pointed at the real app in-process. */
function setup() {
  const app = createApp(testDeps());
  return demoApi(async (path, init) => app.request(path, init));
}
const none = new Set<number>();

function undoButton(blocks: Block[]): { action_id: string; value?: string } {
  for (const block of blocks) {
    if (block.type !== "actions") continue;
    const el = block.elements[0];
    if (el?.type === "button") return { action_id: el.action_id, value: el.value };
  }
  throw new Error("this card has no button");
}

/** Types /ooo and saves the form as it opens. Returns the screen afterwards. */
async function save(api: ReturnType<typeof setup>, id: string) {
  expect(await api.sendCommand(id, "/ooo")).toEqual({ text: "" });
  const open = deriveScreen(await api.getState(id), none).openView;
  if (!open) throw new Error("no form opened");
  const answer = await api.interact(id, viewSubmission(open.view, initialValues(open.view)));
  expect(answer).toEqual({ response_action: "clear" });
  return deriveScreen(await api.getState(id), none);
}

describe("the web emulator's contract with the demo backend", () => {
  it("drives the whole flow with the browser's own payloads", async () => {
    const api = setup();
    const session = await api.createSession("Europe/Paris");
    expect(session.you).toMatchObject({ slackUserId: "U_DANA", tz: "Europe/Paris" });

    const saved = await save(api, session.id);
    expect(saved.messages).toHaveLength(1);
    const receipt = saved.messages[0];
    if (!receipt) throw new Error("no receipt");
    expect(receipt.text).toMatch(/^Out of office · /);
    expect(saved.statuses.U_DANA).toMatchObject({ text: "Out of office", emoji: ":palm_tree:" });

    expect(
      await api.interact(session.id, blockAction(undoButton(receipt.blocks), receipt.seq)),
    ).toBeNull();
    const undone = deriveScreen(await api.getState(session.id), none);
    expect(undone.messages).toHaveLength(1);
    expect(undone.messages[0]?.seq).toBe(receipt.seq);
    expect(undone.messages[0]?.text).toMatch(/^Undone · /);
    expect(undone.statuses.U_DANA).toBeNull();
  });

  it("returns the form's errors keyed by field", async () => {
    const api = setup();
    const { id } = await api.createSession("Europe/Paris");
    await api.sendCommand(id, "/ooo");
    const open = deriveScreen(await api.getState(id), none).openView;
    if (!open) throw new Error("no form opened");
    const answer = await api.interact(
      id,
      viewSubmission(open.view, { ...initialValues(open.view), to: "2000-01-01" }),
    );
    expect(answer).toEqual({
      response_action: "errors",
      errors: { to: "The last day has already passed." },
    });
  });

  it("replaces the card whose button was pressed, not the last message", async () => {
    const api = setup();
    const { id } = await api.createSession("Europe/Paris");
    const first = (await save(api, id)).messages[0];
    const afterSecond = await save(api, id);
    const second = afterSecond.messages[1];
    if (!first || !second) throw new Error("expected two receipts");

    await api.interact(id, blockAction(undoButton(first.blocks), first.seq)); // already replaced: a refusal is appended
    await api.interact(id, blockAction(undoButton(second.blocks), second.seq));
    const screen = deriveScreen(await api.getState(id), none);
    expect(screen.messages).toHaveLength(3);
    expect(screen.messages[0]?.text).toMatch(/^Out of office · /);
    expect(screen.messages[1]?.seq).toBe(second.seq);
    expect(screen.messages[1]?.text).toMatch(/^Undone · /);
    expect(screen.messages[2]?.text).toContain("already replaced by a newer one");
  });

  it("shows a status as cleared once the clock passes its expiration", async () => {
    const api = setup();
    const { id } = await api.createSession("Europe/Paris");
    await save(api, id);
    const later = await api.advance(id, 1440);
    expect(deriveScreen(later, none).statuses.U_DANA).toBeNull();
  });

  it("names an expired session and carries the backend's own sentence for a refusal", async () => {
    const api = setup();
    await expect(api.getState("no-such-session")).rejects.toBeInstanceOf(DemoGone);
    const { id } = await api.createSession("Europe/Paris");
    const refusal = await api.sendCommand(id, "hello").catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(DemoFailed);
    expect((refusal as Error).message).toBe("Only /ooo is available in the demo.");
  });
});
