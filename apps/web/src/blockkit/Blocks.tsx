import type { Block, Element, TextObject } from "@steward/core/blocks";
import type { ReactNode } from "react";
import { emojify } from "./emoji";
import { mrkdwn } from "./mrkdwn";

export type BlockAction = { action_id: string; value?: string };
type OnAction = (action: BlockAction) => void;

const textOf = (t: TextObject): ReactNode =>
  t.type === "mrkdwn" ? mrkdwn(t.text) : emojify(t.text);

export function Unsupported({ what, type }: { what: "block" | "element"; type: string }) {
  return (
    <div
      role="note"
      className="my-1 rounded border border-dashed border-rose-500 px-2 py-1 text-sm text-rose-600"
    >
      unsupported {what}: {type}
    </div>
  );
}

const BUTTON = "inline-block rounded border px-3 py-1 text-sm font-bold disabled:opacity-50";
const BUTTON_STYLE = {
  default: "border-neutral-400 bg-white text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100",
  primary: "border-emerald-700 bg-emerald-700 text-white",
  danger: "border-rose-600 bg-white text-rose-600 dark:bg-neutral-800",
} as const;

function ActionElement(props: { el: Element; onAction?: OnAction; disabled?: boolean }) {
  const { el, onAction, disabled } = props;
  if (el.type !== "button") return <Unsupported what="element" type={el.type} />;
  const className = `${BUTTON} ${BUTTON_STYLE[el.style ?? "default"]}`;
  if (el.url)
    return (
      <a className={className} href={el.url} target="_blank" rel="noreferrer">
        {emojify(el.text.text)}
      </a>
    );
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => onAction?.({ action_id: el.action_id, value: el.value })}
    >
      {emojify(el.text.text)}
    </button>
  );
}

function BlockView(props: { block: Block; onAction?: OnAction; disabled?: boolean }) {
  const { block, onAction, disabled } = props;
  switch (block.type) {
    case "header":
      return <h3 className="text-base font-extrabold">{emojify(block.text.text)}</h3>;
    case "section":
      return (
        <div>
          {block.text ? <p>{textOf(block.text)}</p> : null}
          {block.fields ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {block.fields.map((field, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a block's fields are a fixed list that never reorders
                <p key={i}>{textOf(field)}</p>
              ))}
            </div>
          ) : null}
          {block.accessory ? (
            <div className="mt-1">
              <ActionElement el={block.accessory} onAction={onAction} disabled={disabled} />
            </div>
          ) : null}
        </div>
      );
    case "context":
      return (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {block.elements.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a block's elements are a fixed list that never reorders
            <span key={i} className="mr-2">
              {textOf(t)}
            </span>
          ))}
        </p>
      );
    case "divider":
      return <hr className="my-2 border-neutral-300 dark:border-neutral-700" />;
    case "actions":
      return (
        <div className="flex flex-wrap gap-2 pt-1">
          {block.elements.map((el, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a block's elements are a fixed list that never reorders
            <ActionElement key={i} el={el} onAction={onAction} disabled={disabled} />
          ))}
        </div>
      );
    default:
      // Input blocks belong to modals; anything else is a block this renderer does not know yet.
      return <Unsupported what="block" type={(block as { type: string }).type} />;
  }
}

export function Blocks(props: { blocks: Block[]; onAction?: OnAction; disabled?: boolean }) {
  return (
    <div className="space-y-1">
      {props.blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a message's blocks are a fixed list that never reorders
        <BlockView key={i} block={block} onAction={props.onAction} disabled={props.disabled} />
      ))}
    </div>
  );
}
