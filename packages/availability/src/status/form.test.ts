import { describe, expect, it } from "vitest";
import { buildStatusModal, readStatusSubmission, STATUS_MODAL_CALLBACK } from "./form";

function values(v: {
  type?: string;
  from?: string;
  to?: string;
  text?: string | null;
  emoji?: string | null;
}) {
  return {
    callback_id: STATUS_MODAL_CALLBACK,
    private_metadata: JSON.stringify({ responseUrl: "https://hooks.slack.test/r1" }),
    state: {
      values: {
        type: {
          type: { type: "static_select", selected_option: v.type ? { value: v.type } : null },
        },
        from: { from: { type: "datepicker", selected_date: v.from ?? null } },
        to: { to: { type: "datepicker", selected_date: v.to ?? null } },
        text: { text: { type: "plain_text_input", value: v.text ?? null } },
        emoji: { emoji: { type: "plain_text_input", value: v.emoji ?? null } },
      },
    },
  };
}

describe("buildStatusModal", () => {
  it("has the five inputs, defaults to today, and carries the response_url", () => {
    const view = buildStatusModal({
      today: "2026-11-12",
      responseUrl: "https://hooks.slack.test/r1",
    });
    expect(view.callback_id).toBe(STATUS_MODAL_CALLBACK);
    expect(view.blocks.map((b) => (b.type === "input" ? b.block_id : b.type))).toEqual([
      "type",
      "from",
      "to",
      "text",
      "emoji",
    ]);
    expect(JSON.parse(view.private_metadata ?? "{}")).toEqual({
      responseUrl: "https://hooks.slack.test/r1",
    });
    const from = view.blocks[1];
    expect(
      from?.type === "input" && from.element.type === "datepicker" && from.element.initial_date,
    ).toBe("2026-11-12");
  });
});

describe("readStatusSubmission", () => {
  it("reads a full submission", () => {
    const result = readStatusSubmission(
      values({ type: "out", from: "2026-11-12", to: "2026-11-17", text: "Away", emoji: ":beach:" }),
    );
    expect(result).toEqual({
      ok: true,
      input: { type: "out", from: "2026-11-12", to: "2026-11-17", text: "Away", emoji: ":beach:" },
      meta: { responseUrl: "https://hooks.slack.test/r1" },
    });
  });

  it("fills blank text and emoji from the type's defaults", () => {
    const result = readStatusSubmission(
      values({ type: "sick", from: "2026-11-12", to: "2026-11-12", text: "  " }),
    );
    expect(result.ok && result.input.text).toBe("Out sick");
    expect(result.ok && result.input.emoji).toBe(":face_with_thermometer:");
  });

  it("rejects an end before the start, and a missing type, with field errors", () => {
    const bad = readStatusSubmission(values({ type: "out", from: "2026-11-12", to: "2026-11-11" }));
    expect(bad).toEqual({ ok: false, errors: { to: "The last day can't be before the first" } });
    const noType = readStatusSubmission(values({ from: "2026-11-12", to: "2026-11-12" }));
    expect(!noType.ok && noType.errors.type).toBe("Pick what's happening");
  });
});
