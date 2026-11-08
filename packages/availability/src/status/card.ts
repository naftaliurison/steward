import {
  actions,
  type Block,
  button,
  context,
  header,
  type StatusRow,
  section,
  type TargetRow,
} from "@steward/core";
import { formatDay, formatRange, formatTime } from "./time";
import { STATUS_LABEL, type StatusType } from "./types";

export const UNDO_ACTION = "status_undo";

const SYSTEM_NAME: Record<string, string> = { "slack-status": "Slack status" };

/** One line per system write, in the words the spec uses: done, didn't go through, skipped, cleared, pending. */
export function targetLine(target: TargetRow, status: StatusRow, tz: string): string {
  const name = SYSTEM_NAME[target.system] ?? target.system;
  switch (target.state) {
    case "done":
      return `✅ ${name} set — clears ${formatDay(status.endMs - 1, tz)}`;
    case "failed":
      return `❌ ${name} didn't go through — ${target.lastError ?? "unknown error"}`;
    case "skipped":
      return `➖ ${name} skipped — ${target.lastError ?? "no reason recorded"}`;
    case "undone":
      return `↩️ ${name} cleared`;
    default:
      return `⏳ ${name} — will be set when it starts (${formatDay(status.startMs, tz)})`;
  }
}

export function resultCard(args: {
  status: StatusRow;
  targets: TargetRow[];
  tz: string;
  now: number;
}): { text: string; blocks: Block[] } {
  const { status, targets, tz, now } = args;
  const label = STATUS_LABEL[status.type as StatusType] ?? status.type;
  const range = formatRange(status.startMs, status.endMs, tz);
  const title =
    status.state === "cancelled" ? `Undone · ${label} · ${range}` : `${label} · ${range}`;
  const lines = targets.map((t) => targetLine(t, status, tz)).join("\n");
  const blocks: Block[] = [header(title), section(lines || "Nothing to write for this status.")];
  const canUndo =
    status.state !== "cancelled" && status.undoUntilMs !== null && status.undoUntilMs > now;
  if (canUndo && status.undoUntilMs !== null) {
    blocks.push(actions(button("Undo", UNDO_ACTION, { value: status.id, style: "danger" })));
    blocks.push(context(`You can undo until ${formatTime(status.undoUntilMs, tz)}.`));
  }
  return { text: title, blocks };
}
