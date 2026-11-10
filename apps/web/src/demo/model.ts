import type { Block, ModalView } from "@steward/core/blocks";
import { emojify } from "../blockkit/emoji";
import type { DemoState, SlackStatus } from "./api";

export type Message = { seq: number; at: number; text: string; blocks: Block[] };
export type Screen = {
  messages: Message[];
  openView: { seq: number; view: ModalView } | null;
  /** Keyed by Slack user id. null means the status was cleared or has expired. */
  statuses: Record<string, SlackStatus | null>;
};

/** A button press's response URL ends with the seq of the message the button lives on. */
const TARGET = /\/(\d{1,10})$/;

/** Everything the screen shows, from what the fake Slack recorded. `closedViews` are forms the visitor dismissed or saved. */
export function deriveScreen(
  state: Pick<DemoState, "now" | "events">,
  closedViews: ReadonlySet<number>,
): Screen {
  const messages: Message[] = [];
  const statuses: Record<string, SlackStatus | null> = {};
  let openView: Screen["openView"] = null;
  for (const event of state.events) {
    if (event.kind === "view") {
      openView = closedViews.has(event.seq) ? null : { seq: event.seq, view: event.payload.view };
    } else if (event.kind === "response") {
      const { text, blocks, replaceOriginal, responseUrl } = event.payload;
      let index = -1;
      if (replaceOriginal) {
        const named = TARGET.exec(responseUrl)?.[1];
        index =
          named === undefined
            ? messages.length - 1
            : messages.findIndex((m) => m.seq === Number(named));
      }
      const original = messages[index];
      // A replaced card keeps its place and its identity, as a Slack message keeps its timestamp.
      if (original) messages[index] = { seq: original.seq, at: original.at, text, blocks };
      else messages.push({ seq: event.seq, at: event.at, text, blocks });
    } else if (event.kind === "message") {
      const { text, blocks } = event.payload;
      messages.push({ seq: event.seq, at: event.at, text, blocks });
    } else {
      statuses[event.payload.slackUserId] = event.payload.status;
    }
  }
  // Slack clears a status by itself when its expiration passes.
  for (const [user, status] of Object.entries(statuses)) {
    if (status && status.expiration > 0 && status.expiration * 1000 <= state.now)
      statuses[user] = null;
  }
  return { messages, openView, statuses };
}

/** Something the emulator itself says in the thread (a refusal's sentence, a fresh-session note). */
export type Notice = { id: number; afterSeq: number; text: string };
export type ThreadItem =
  | { kind: "message"; key: string; message: Message }
  | { kind: "notice"; key: string; text: string };

/** Messages and notices in the order they appeared. */
export function thread(messages: Message[], notices: Notice[]): ThreadItem[] {
  const rows: { order: number; tie: number; item: ThreadItem }[] = [
    ...messages.map((message) => ({
      order: message.seq,
      tie: 0,
      item: { kind: "message" as const, key: `m${message.seq}`, message },
    })),
    ...notices.map((notice) => ({
      order: notice.afterSeq + 0.5,
      tie: notice.id,
      item: { kind: "notice" as const, key: `n${notice.id}`, text: notice.text },
    })),
  ];
  rows.sort((a, b) => a.order - b.order || a.tie - b.tie);
  return rows.map((row) => row.item);
}

export function formatDay(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(epochMs));
}

export function formatTime(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochMs));
}

/** The side panel's one line for a person's Slack status. The expiration is the midnight after the last day. */
export function statusLine(status: SlackStatus | null | undefined, tz: string): string {
  if (!status) return "No status set";
  const until =
    status.expiration > 0 ? ` · until ${formatDay(status.expiration * 1000 - 1, tz)}` : "";
  return `${emojify(status.emoji)} ${status.text}${until}`;
}
