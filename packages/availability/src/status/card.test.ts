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
});
