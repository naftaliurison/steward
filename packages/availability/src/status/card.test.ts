import type { StatusRow, TargetRow } from "@steward/core";
import { describe, expect, it } from "vitest";
import { resultCard, UNDO_ACTION } from "./card";

const now = Date.UTC(2026, 10, 12, 8, 0);
const status: StatusRow = {
  id: "S1",
  workspaceId: "T1",
  personId: "T1:U1",
  type: "out",
  startMs: Date.UTC(2026, 10, 11, 22),
  endMs: Date.UTC(2026, 10, 17, 22),
  text: "Out of office",
  emoji: ":palm_tree:",
  state: "active",
  source: "form",
  createdAt: now,
  undoUntilMs: now + 300_000,
  replacedStatusId: null,
};
const target = (
  state: string,
  lastError: string | null = null,
  nextAttemptAt: number | null = null,
): TargetRow => ({
  id: "G1",
  statusId: "S1",
  system: "slack-status",
  op: "set",
  spec: "{}",
  state,
  externalId: null,
  attempts: 1,
  lastError,
  nextAttemptAt,
  idempotencyKey: "S1:slack-status:set",
});

describe("resultCard", () => {
  it("shows the headline, one honest line per system, and Undo inside the window", () => {
    const card = resultCard({ status, targets: [target("done")], tz: "Asia/Jerusalem", now });
    expect(card.text).toMatch(/^Out of office · Thu,? 12 Nov – Tue,? 17 Nov$/);
    const lines = card.blocks[1];
    expect(lines?.type === "section" && lines.text?.text).toContain("✅ Slack status set");
    const buttons = card.blocks[2];
    expect(
      buttons?.type === "actions" &&
        buttons.elements[0]?.type === "button" &&
        buttons.elements[0].action_id,
    ).toBe(UNDO_ACTION);
    expect(
      buttons?.type === "actions" &&
        buttons.elements[0]?.type === "button" &&
        buttons.elements[0].value,
    ).toBe("S1");
  });

  it("words failures and skips plainly", () => {
    const failed = resultCard({
      status,
      targets: [target("failed", "ratelimited")],
      tz: "UTC",
      now,
    });
    expect(failed.blocks[1]?.type === "section" && failed.blocks[1].text?.text).toBe(
      "❌ Slack status didn't go through — ratelimited",
    );
    const skipped = resultCard({
      status,
      targets: [target("skipped", "Slack isn't connected for you yet — use Connect Slack first")],
      tz: "UTC",
      now,
    });
    expect(skipped.blocks[1]?.type === "section" && skipped.blocks[1].text?.text).toContain(
      "➖ Slack status skipped — Slack isn't connected",
    );
  });

  it("drops Undo after the window and after an undo", () => {
    const late = resultCard({ status, targets: [target("done")], tz: "UTC", now: now + 400_000 });
    expect(late.blocks.some((b) => b.type === "actions")).toBe(false);
    const undone = resultCard({
      status: { ...status, state: "cancelled", undoUntilMs: null },
      targets: [target("undone")],
      tz: "UTC",
      now,
    });
    expect(undone.text.startsWith("Undone · Out of office")).toBe(true);
    expect(undone.blocks[1]?.type === "section" && undone.blocks[1].text?.text).toBe(
      "↩️ Slack status cleared",
    );
  });

  it("a scheduled status says so and offers Cancel until it starts", () => {
    const startMs = now + 2 * 86_400_000;
    const scheduled = { ...status, state: "scheduled", startMs, undoUntilMs: startMs };
    const card = resultCard({
      status: scheduled,
      targets: [{ ...target("pending"), attempts: 0 }],
      tz: "UTC",
      now,
    });
    expect(card.text.startsWith("Scheduled · Out of office · ")).toBe(true);
    const json = JSON.stringify(card.blocks);
    expect(json).toContain('"Cancel"');
    expect(json).not.toContain('"Undo"');
    expect(json).toContain("You can cancel until it starts (");
  });

  it("a status cancelled before it started is called cancelled, and nothing was cleared", () => {
    const startMs = now + 2 * 86_400_000;
    const card = resultCard({
      status: { ...status, state: "cancelled", startMs, undoUntilMs: null },
      targets: [{ ...target("undone"), attempts: 1 }],
      tz: "UTC",
      now,
    });
    expect(card.text.startsWith("Cancelled · Out of office · ")).toBe(true);
    const json = JSON.stringify(card.blocks);
    expect(json).toContain("↩️ Slack status — won't be set");
    expect(json).not.toContain("cleared");
    expect(card.blocks.some((b) => b.type === "actions")).toBe(false);
  });

  describe("Google lines and notes", () => {
    const sys = (system: string, state: string, lastError: string | null = null): TargetRow => ({
      ...target(state, lastError),
      id: `G-${system}`,
      system,
      idempotencyKey: `S1:${system}:set`,
    });
    const range = "Thu 12 Nov – Tue 17 Nov";
    const textOf = (card: { blocks: { type: string }[] }, i: number) => {
      const b = card.blocks[i] as { text?: { text: string } };
      return b.text?.text;
    };

    it("lists Slack, Calendar, Gmail in that order whatever order they arrive in", () => {
      const card = resultCard({
        status,
        targets: [
          sys("gmail-responder", "done"),
          sys("google-calendar", "done"),
          sys("slack-status", "done"),
        ],
        tz: "Asia/Jerusalem",
        now,
      });
      expect(
        textOf(card, 1)
          ?.split("\n")
          .map((l) => l.split(" ").slice(0, 3).join(" ")),
      ).toEqual(["✅ Slack status", "✅ Calendar event", "✅ Gmail auto-reply"]);
    });

    it("words the Google lines", () => {
      const lines = (state: string, system: string, err: string | null = null) =>
        textOf(
          resultCard({ status, targets: [sys(system, state, err)], tz: "Asia/Jerusalem", now }),
          1,
        );
      expect(lines("done", "google-calendar")).toBe(`✅ Calendar event added — ${range}`);
      expect(lines("done", "gmail-responder")).toBe(`✅ Gmail auto-reply on — ${range}`);
      expect(lines("failed", "google-calendar", "boom")).toBe(
        "❌ Calendar event didn't go through — boom",
      );
      expect(lines("skipped", "gmail-responder", "Google was disconnected")).toBe(
        "➖ Gmail auto-reply skipped — Google was disconnected",
      );
      expect(lines("undone", "google-calendar")).toBe("↩️ Calendar event removed");
      expect(lines("undone", "gmail-responder")).toBe("↩️ Gmail auto-reply turned off");
      expect(lines("pending", "google-calendar")).toBe(
        "⏳ Calendar event — Steward is still trying",
      );
    });

    it("says what an Undo left in place, and why", () => {
      const lines = (state: string, system: string, err: string | null) =>
        textOf(
          resultCard({ status, targets: [sys(system, state, err)], tz: "Asia/Jerusalem", now }),
          1,
        );
      expect(lines("undone", "google-calendar", "Google isn't connected")).toBe(
        "↩️ Calendar event left in place: Google isn't connected",
      );
      expect(lines("undone", "gmail-responder", "Google isn't connected")).toBe(
        "↩️ Gmail auto-reply left in place: Google isn't connected",
      );
      // An undone target with no reason (a pending one the engine retired) reads as before.
      expect(lines("undone", "google-calendar", null)).toBe("↩️ Calendar event removed");
      expect(lines("undone", "slack-status", null)).toBe("↩️ Slack status cleared");
    });

    it("shows the reason of a failed Undo after the normal line of a done target", () => {
      const lines = (system: string) =>
        textOf(
          resultCard({
            status,
            targets: [sys(system, "done", "undo didn't go through — rate limited")],
            tz: "Asia/Jerusalem",
            now,
          }),
          1,
        );
      expect(lines("google-calendar")).toBe(
        `✅ Calendar event added — ${range} — undo didn't go through — rate limited`,
      );
      expect(lines("slack-status")).toBe(
        "✅ Slack status set — clears Tue 17 Nov — undo didn't go through — rate limited",
      );
    });

    it("adds each note as a context block after the lines and before the buttons", () => {
      const card = resultCard({
        status,
        targets: [target("done")],
        tz: "UTC",
        now,
        notes: ["first", "second"],
      });
      expect(card.blocks.map((b) => b.type)).toEqual([
        "header",
        "section",
        "context",
        "context",
        "actions",
        "context",
      ]);
      expect(JSON.stringify(card.blocks[2])).toContain("💡 first");
      expect(JSON.stringify(card.blocks[3])).toContain("💡 second");
    });

    it("without notes the blocks are unchanged", () => {
      const plain = resultCard({ status, targets: [target("done")], tz: "UTC", now });
      const empty = resultCard({ status, targets: [target("done")], tz: "UTC", now, notes: [] });
      expect(empty.blocks).toEqual(plain.blocks);
      expect(plain.blocks).toHaveLength(4);
    });
  });
});
