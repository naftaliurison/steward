import type { ModalView } from "@steward/core/blocks";

/** A modal's field values, keyed by input block_id. "" means empty. */
export type Values = Record<string, string>;

export function initialValues(view: ModalView): Values {
  const values: Values = {};
  for (const block of view.blocks) {
    if (block.type !== "input") continue;
    const el = block.element;
    if (el.type === "static_select") values[block.block_id] = el.initial_option?.value ?? "";
    else if (el.type === "datepicker") values[block.block_id] = el.initial_date ?? "";
    else if (el.type === "plain_text_input") values[block.block_id] = el.initial_value ?? "";
  }
  return values;
}
