import type { ReactNode } from "react";
import { emojify } from "./emoji";

/** A line break, *bold* (no space inside the stars), or _italic_ (no word character outside the pair, no space inside). */
const TOKEN = /\n|\*(?=\S)([^*\n]*?\S)\*|(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu;
const CODE = /(`[^`\n]+`)/;

/** Slack mrkdwn as far as the product uses it: *bold*, _italic_, `code`, line breaks, :emoji:. */
export function mrkdwn(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let key = 0;
  for (const piece of source.split(CODE)) {
    if (piece === "") continue;
    if (piece.length > 2 && piece.startsWith("`") && piece.endsWith("`")) {
      nodes.push(
        <code key={key++} className="rounded bg-black/10 px-1 text-[0.9em] dark:bg-white/10">
          {piece.slice(1, -1)}
        </code>,
      );
      continue;
    }
    const text = emojify(piece);
    let last = 0;
    for (const m of text.matchAll(TOKEN)) {
      if (m.index > last) nodes.push(<span key={key++}>{text.slice(last, m.index)}</span>);
      if (m[0] === "\n") nodes.push(<br key={key++} />);
      else if (m[1] !== undefined) nodes.push(<strong key={key++}>{m[1]}</strong>);
      else nodes.push(<em key={key++}>{m[2]}</em>);
      last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push(<span key={key++}>{text.slice(last)}</span>);
  }
  return nodes;
}
