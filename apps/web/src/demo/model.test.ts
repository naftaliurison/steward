import { describe, expect, it } from "vitest";
import type { DemoEvent, SlackStatus } from "./api";
import { deriveScreen, statusLine, thread } from "./model";

// The id's last group is all digits on purpose: it must never be read as a message number.
const BASE = "https://hooks.slack.com/demo/3f2b8c1e-0000-4000-8000-123456789012";
const view = (seq: number): DemoEvent => ({
  seq,
  kind: "view",
  at: 1,
  payload: {
    triggerId: `t${seq}`,
    view: {
      type: "modal",
      callback_id: "ooo_status",
      title: { type: "plain_text", text: "Form" },
      blocks: [],
    },
  },
});
const response = (
  seq: number,
  text: string,
  opts: { replace?: boolean; target?: number } = {},
): DemoEvent => ({
  seq,
  kind: "response",
  at: seq * 1000,
  payload: {
    responseUrl: opts.target === undefined ? BASE : `${BASE}/${opts.target}`,
    text,
    blocks: [],
    replaceOriginal: opts.replace ?? false,
  },
});
const status = (seq: number, s: SlackStatus | null): DemoEvent => ({
  seq,
  kind: "status",
  at: 1,
  payload: { slackUserId: "U_DANA", status: s },
});
const none = new Set<number>();
const texts = (events: DemoEvent[]) =>
  deriveScreen({ now: 0, events }, none).messages.map((m) => `${m.seq}:${m.text}`);

describe("deriveScreen", () => {
  it("shows the newest form unless the visitor closed it", () => {
    const events = [view(1), view(4)];
    expect(deriveScreen({ now: 0, events }, none).openView?.seq).toBe(4);
    expect(deriveScreen({ now: 0, events }, new Set([1])).openView?.seq).toBe(4);
    expect(deriveScreen({ now: 0, events }, new Set([4])).openView).toBeNull();
  });

  it("appends receipts, and replaces the card a button lived on in place", () => {
    const events = [
      response(2, "A"),
      response(3, "B"),
      response(5, "That status was already replaced"),
      response(6, "Undone B", { replace: true, target: 3 }),
    ];
    expect(texts(events)).toEqual(["2:A", "3:Undone B", "5:That status was already replaced"]);
  });

  it("replaces the last message when the URL names none, and appends when there is nothing to replace", () => {
    expect(texts([response(2, "A"), response(3, "Undone A", { replace: true })])).toEqual([
      "2:Undone A",
    ]);
    expect(texts([response(2, "Undone", { replace: true, target: 9 })])).toEqual(["2:Undone"]);
  });

  it("tracks a person's Slack status and clears it once its expiration passes", () => {
    const set = status(1, { text: "Out of office", emoji: ":palm_tree:", expiration: 2000 });
    expect(deriveScreen({ now: 1_999_999, events: [set] }, none).statuses.U_DANA?.text).toBe(
      "Out of office",
    );
    expect(deriveScreen({ now: 2_000_000, events: [set] }, none).statuses.U_DANA).toBeNull();
    expect(
      deriveScreen({ now: 0, events: [set, status(2, null)] }, none).statuses.U_DANA,
    ).toBeNull();
  });
});

describe("thread", () => {
  it("puts each notice after the message that was newest when it appeared", () => {
    const messages = [
      { seq: 3, at: 0, text: "m3", blocks: [] },
      { seq: 7, at: 0, text: "m7", blocks: [] },
    ];
    const notices = [
      { id: 1, afterSeq: 3, text: "n1" },
      { id: 2, afterSeq: 3, text: "n2" },
      { id: 3, afterSeq: 0, text: "first" },
    ];
    expect(thread(messages, notices).map((i) => i.key)).toEqual(["n3", "m3", "n1", "n2", "m7"]);
  });
});

describe("statusLine", () => {
  it("describes a status the way the side panel shows it", () => {
    const until = Date.UTC(2026, 10, 13, 0, 0) / 1000; // the midnight after Thu 12 Nov, in London
    expect(
      statusLine(
        { text: "Out of office", emoji: ":palm_tree:", expiration: until },
        "Europe/London",
      ),
    ).toBe("🌴 Out of office · until Thu 12 Nov");
    expect(statusLine(null, "Europe/London")).toBe("No status set");
  });
});
