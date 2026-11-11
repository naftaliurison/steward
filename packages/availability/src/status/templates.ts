import { formatDay } from "./time";
import type { StatusType } from "./types";

/** The subject and body of the Gmail auto-reply for a status. `endMs` is exclusive. */
export function autoReply(
  type: StatusType,
  times: { startMs: number; endMs: number },
  tz: string,
): { subject: string; body: string } {
  const first = formatDay(times.startMs, tz);
  const last = formatDay(times.endMs - 1, tz);
  const oneDay = first === last;
  const back = "and will reply when I'm back.";
  if (type === "out") {
    return {
      subject: "Out of office",
      body: oneDay
        ? `I'm out of office on ${first} ${back}`
        : `I'm out of office from ${first} to ${last} ${back}`,
    };
  }
  if (type === "sick") {
    return {
      subject: "Away sick",
      body: oneDay ? `I'm off sick today (${first}) ${back}` : `I'm off sick until ${last} ${back}`,
    };
  }
  return {
    subject: "Away",
    body: oneDay ? `I'm away on ${first} ${back}` : `I'm away from ${first} to ${last} ${back}`,
  };
}
