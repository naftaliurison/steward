import type { WriteSpec } from "@steward/core";
import type { StatusInput } from "./types";

export const SLACK_STATUS = "slack-status";

/** Which systems get written for a status. Slack always; Calendar and Gmail are added as further specs here. */
export function planWrites(
  input: StatusInput,
  times: { startMs: number; endMs: number },
): WriteSpec[] {
  return [
    {
      system: SLACK_STATUS,
      op: "set",
      args: { text: input.text, emoji: input.emoji, expiration: Math.floor(times.endMs / 1000) },
    },
  ];
}
