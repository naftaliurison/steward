import type { ModalView } from "@steward/core/blocks";
import type { Values } from "../blockkit/values";

type ValueNode =
  | { type: "static_select"; selected_option: { value: string } | null }
  | { type: "datepicker"; selected_date: string | null }
  | { type: "plain_text_input"; value: string | null };

/** What Slack sends when a modal is submitted. The backend fills in who, where and the metadata. */
export function viewSubmission(view: ModalView, values: Values) {
  const stateValues: Record<string, Record<string, ValueNode>> = {};
  for (const block of view.blocks) {
    if (block.type !== "input") continue;
    const el = block.element;
    const value = values[block.block_id] ?? "";
    let node: ValueNode | null = null;
    if (el.type === "static_select")
      node = { type: el.type, selected_option: value ? { value } : null };
    else if (el.type === "datepicker") node = { type: el.type, selected_date: value || null };
    else if (el.type === "plain_text_input") node = { type: el.type, value: value || null };
    if (node) stateValues[block.block_id] = { [el.action_id]: node };
  }
  return {
    type: "view_submission" as const,
    view: { type: "modal", callback_id: view.callback_id, state: { values: stateValues } },
  };
}

/** What Slack sends when a button on a message is pressed. `messageSeq` names the message it lives on. */
export function blockAction(action: { action_id: string; value?: string }, messageSeq: number) {
  return {
    type: "block_actions" as const,
    container: { type: "message", message_ts: String(messageSeq) },
    actions: [{ type: "button", action_id: action.action_id, value: action.value }],
  };
}
