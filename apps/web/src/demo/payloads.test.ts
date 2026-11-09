import {
  datepicker,
  input,
  type ModalView,
  option,
  plain,
  staticSelect,
  textInput,
} from "@steward/core/blocks";
import { describe, expect, it } from "vitest";
import { blockAction, viewSubmission } from "./payloads";

const view: ModalView = {
  type: "modal",
  callback_id: "ooo_status",
  title: plain("Set your availability"),
  blocks: [
    input("type", "What's happening?", staticSelect("type", [option("Out of office", "out")])),
    input("from", "From", datepicker("from", "2026-11-12")),
    input("text", "Status text", textInput("text"), true),
  ],
};

describe("payloads", () => {
  it("builds the view_submission Slack would send, with empty fields as null", () => {
    expect(viewSubmission(view, { type: "out", from: "2026-11-12", text: "" })).toEqual({
      type: "view_submission",
      view: {
        type: "modal",
        callback_id: "ooo_status",
        state: {
          values: {
            type: { type: { type: "static_select", selected_option: { value: "out" } } },
            from: { from: { type: "datepicker", selected_date: "2026-11-12" } },
            text: { text: { type: "plain_text_input", value: null } },
          },
        },
      },
    });
    expect(viewSubmission(view, {}).view).toMatchObject({
      state: {
        values: {
          type: { type: { selected_option: null } },
          from: { from: { selected_date: null } },
        },
      },
    });
  });

  it("builds a block_actions payload that names the message the button lives on", () => {
    expect(blockAction({ action_id: "status_undo", value: "st_1" }, 3)).toEqual({
      type: "block_actions",
      container: { type: "message", message_ts: "3" },
      actions: [{ type: "button", action_id: "status_undo", value: "st_1" }],
    });
  });
});
