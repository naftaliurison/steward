import { calendarsOf, type GoogleConnectionRow, type WriteSpec } from "@steward/core";
import { autoReply } from "./templates";
import type { StatusInput, StatusType } from "./types";

export const SLACK_STATUS = "slack-status";
export const GOOGLE_CALENDAR = "google-calendar";
export const GMAIL_RESPONDER = "gmail-responder";

/** The status types that also write to Google. */
export const GOOGLE_TYPES: readonly StatusType[] = ["out", "sick"];

/** Systems that accept future dates: written when the status is saved, not when it starts. */
export function writesAtSave(system: string): boolean {
  return system === GOOGLE_CALENDAR || system === GMAIL_RESPONDER;
}

export type CalendarWriteArgs = {
  /** The status text. */
  summary: string;
  /** First day, YYYY-MM-DD. */
  from: string;
  /** Last day, YYYY-MM-DD. */
  to: string;
  tz: string;
  /** The chosen calendars, at plan time. */
  calendars: { id: string; primary: boolean }[];
};
export type ResponderWriteArgs = { subject: string; body: string; startMs: number; endMs: number };

/**
 * Which systems get written for a status: Slack always; for out and sick with Google connected, also
 * the calendar event and the Gmail auto-reply. The connection's health is not looked at here: the
 * connectors decide that and skip with a reason.
 */
export function planWrites(
  input: StatusInput,
  times: { startMs: number; endMs: number },
  opts: { tz: string; google: GoogleConnectionRow | null },
): WriteSpec[] {
  const specs: WriteSpec[] = [
    {
      system: SLACK_STATUS,
      op: "set",
      args: { text: input.text, emoji: input.emoji, expiration: Math.floor(times.endMs / 1000) },
    },
  ];
  if (!opts.google || !GOOGLE_TYPES.includes(input.type)) return specs;
  const calendars = calendarsOf(opts.google)
    .filter((c) => c.chosen)
    .map((c) => ({ id: c.id, primary: c.primary }));
  if (calendars.length > 0) {
    const args: CalendarWriteArgs = {
      summary: input.text,
      from: input.from,
      to: input.to,
      tz: opts.tz,
      calendars,
    };
    specs.push({ system: GOOGLE_CALENDAR, op: "set", args });
  }
  const args: ResponderWriteArgs = {
    ...autoReply(input.type, times, opts.tz),
    startMs: times.startMs,
    endMs: times.endMs,
  };
  specs.push({ system: GMAIL_RESPONDER, op: "set", args });
  return specs;
}
