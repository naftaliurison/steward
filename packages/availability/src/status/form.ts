import {
  datepicker,
  input,
  type ModalView,
  option,
  plain,
  staticSelect,
  textInput,
} from "@steward/core";
import {
  STATUS_DEFAULTS,
  STATUS_LABEL,
  STATUS_TYPES,
  type StatusInput,
  type StatusType,
} from "./types";

export const STATUS_MODAL_CALLBACK = "ooo_status";
export const FIELD = {
  type: "type",
  from: "from",
  to: "to",
  text: "text",
  emoji: "emoji",
} as const;

export type ModalMeta = { responseUrl: string };

export function buildStatusModal(opts: {
  today: string;
  responseUrl: string;
  initial?: Partial<StatusInput>;
}): ModalView {
  const type: StatusType = opts.initial?.type ?? "out";
  const defaults = STATUS_DEFAULTS[type];
  const meta: ModalMeta = { responseUrl: opts.responseUrl };
  const from = opts.initial?.from ?? opts.today;
  return {
    type: "modal",
    callback_id: STATUS_MODAL_CALLBACK,
    title: plain("Set your availability"),
    submit: plain("Save"),
    close: plain("Cancel"),
    private_metadata: JSON.stringify(meta),
    blocks: [
      input(
        FIELD.type,
        "What's happening?",
        staticSelect(
          FIELD.type,
          STATUS_TYPES.map((t) => option(STATUS_LABEL[t], t)),
          option(STATUS_LABEL[type], type),
        ),
      ),
      input(FIELD.from, "From", datepicker(FIELD.from, from)),
      input(FIELD.to, "To (last day)", datepicker(FIELD.to, opts.initial?.to ?? from)),
      input(
        FIELD.text,
        "Status text",
        textInput(FIELD.text, opts.initial?.text ?? defaults.text),
        true,
      ),
      input(
        FIELD.emoji,
        "Emoji",
        textInput(FIELD.emoji, opts.initial?.emoji ?? defaults.emoji, ":palm_tree:"),
        true,
      ),
    ],
  };
}

type ValueNode = {
  type: string;
  value?: string | null;
  selected_date?: string | null;
  selected_option?: { value: string } | null;
};
export type ViewState = { values: Record<string, Record<string, ValueNode>> };
export type SubmittedView = { callback_id: string; private_metadata?: string; state: ViewState };
export type ReadResult =
  | { ok: true; input: StatusInput; meta: ModalMeta }
  | { ok: false; errors: Record<string, string> };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMOJI = /^:[a-z0-9_+'-]+:$/;
const MAX_TEXT = 100;

function isStatusType(v: string): v is StatusType {
  return (STATUS_TYPES as readonly string[]).includes(v);
}

/** True for a real calendar date in YYYY-MM-DD form (2026-02-30 is not one). */
function isRealDate(d: string): boolean {
  if (!DATE.test(d)) return false;
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, day)).toISOString().slice(0, 10) === d;
}

/**
 * Reads the submitted form. `today` is the person's local date: statuses must start today until
 * scheduling arrives (Plan 3), and the last day may not already be over.
 */
export function readStatusSubmission(view: SubmittedView, opts: { today: string }): ReadResult {
  const node = (block: string): ValueNode | undefined => view.state.values[block]?.[block];
  const type = node(FIELD.type)?.selected_option?.value ?? "";
  const from = node(FIELD.from)?.selected_date ?? "";
  const to = node(FIELD.to)?.selected_date ?? "";
  const rawText = (node(FIELD.text)?.value ?? "").trim();
  const rawEmoji = (node(FIELD.emoji)?.value ?? "").trim();

  const errors: Record<string, string> = {};
  if (!isStatusType(type)) errors[FIELD.type] = "Pick what's happening";
  if (!DATE.test(from)) errors[FIELD.from] = "Pick a start date";
  else if (!isRealDate(from)) errors[FIELD.from] = "That date doesn't exist.";
  else if (from > opts.today)
    errors[FIELD.from] = "Scheduling arrives in a later version — for now, the first day is today.";
  if (!DATE.test(to)) errors[FIELD.to] = "Pick an end date";
  else if (!isRealDate(to)) errors[FIELD.to] = "That date doesn't exist.";
  else if (to < opts.today) errors[FIELD.to] = "The last day has already passed.";
  else if (DATE.test(from) && to < from)
    errors[FIELD.to] = "The last day can't be before the first";
  if (rawText.length > MAX_TEXT) errors[FIELD.text] = "Keep the status text under 100 characters.";
  if (rawEmoji && !EMOJI.test(rawEmoji))
    errors[FIELD.emoji] = "Write the emoji the way Slack does, like :palm_tree:.";
  if (!isStatusType(type) || Object.keys(errors).length > 0) return { ok: false, errors };

  const defaults = STATUS_DEFAULTS[type];
  const text = rawText || defaults.text;
  const emoji = rawEmoji || defaults.emoji;
  let meta: ModalMeta = { responseUrl: "" };
  try {
    meta = {
      responseUrl: "",
      ...(JSON.parse(view.private_metadata ?? "{}") as Partial<ModalMeta>),
    };
  } catch {
    // malformed metadata: keep the empty response_url and still save
  }
  return { ok: true, input: { type, from, to, text, emoji }, meta };
}
