import type { ReactNode } from "react";
import { emojify } from "./emoji";

const TOKEN = /(\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\n)/;
const wrapped = (part: string, mark: string) =>
  part.length > 2 && part.startsWith(mark) && part.endsWith(mark);

/** Slack mrkdwn as far as the product uses it: *bold*, _italic_, `code`, line breaks, :emoji:. */
export function mrkdwn(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const part of emojify(source).split(TOKEN)) {
    if (part === "") continue;
    const key = offset;
    offset += part.length;
    const inner = part.slice(1, -1);
    if (part === "\n") nodes.push(<br key={key} />);
    else if (wrapped(part, "*")) nodes.push(<strong key={key}>{inner}</strong>);
    else if (wrapped(part, "_")) nodes.push(<em key={key}>{inner}</em>);
    else if (wrapped(part, "`"))
      nodes.push(
        <code key={key} className="rounded bg-black/10 px-1 text-[0.9em] dark:bg-white/10">
          {inner}
        </code>,
      );
    else nodes.push(<span key={key}>{part}</span>);
  }
  return nodes;
}
