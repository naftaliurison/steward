import {
  type Connector,
  type ConnectorCtx,
  GOOGLE_SCOPE,
  GoogleApiError,
  type GoogleClient,
  type GoogleEventInput,
  type GoogleTokenSource,
  SkipWrite,
  type WriteSpec,
} from "@steward/core";
import { type CalendarWriteArgs, GOOGLE_CALENDAR } from "../status/plan";
import { nextDay, zonedTimeToEpochMs } from "../status/time";
import { expiringOn401, googleAccessOrSkip } from "./googleAccess";

export const DECLINE_MESSAGE = "Declined because I am out of office.";

/**
 * The same event id on every calendar and on every retry: "st" + the SHA-256 of the key in hex.
 * Google takes only 0-9 and a-v in an event id, so the prefix must stay inside those letters.
 */
export async function eventIdFor(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idempotencyKey));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `st${hex}`;
}

/** Puts an out-of-office event on each chosen calendar, and removes it on undo. */
export class GoogleCalendarConnector implements Connector {
  readonly system = GOOGLE_CALENDAR;
  private readonly google: GoogleClient;
  private readonly tokens: GoogleTokenSource;

  constructor(deps: { google: GoogleClient; tokens: GoogleTokenSource }) {
    this.google = deps.google;
    this.tokens = deps.tokens;
  }

  async perform(spec: WriteSpec, ctx: ConnectorCtx): Promise<{ externalId: string }> {
    const args = spec.args as CalendarWriteArgs;
    const { accessToken } = await googleAccessOrSkip(
      this.tokens,
      ctx.personId,
      GOOGLE_SCOPE.calendarEvents,
    );
    const id = await eventIdFor(ctx.idempotencyKey);

    const allDay: GoogleEventInput = {
      id,
      summary: args.summary,
      start: { date: args.from },
      end: { date: nextDay(args.to) },
      transparency: "opaque",
    };
    const outOfOffice: GoogleEventInput = {
      id,
      summary: args.summary,
      start: { dateTime: new Date(zonedTimeToEpochMs(args.from, "00:00", args.tz)).toISOString() },
      end: {
        dateTime: new Date(zonedTimeToEpochMs(nextDay(args.to), "00:00", args.tz)).toISOString(),
      },
      transparency: "opaque",
      eventType: "outOfOffice",
      outOfOfficeProperties: {
        autoDeclineMode: "declineOnlyNewConflictingInvitations",
        declineMessage: DECLINE_MESSAGE,
      },
    };

    for (const calendar of args.calendars) {
      await expiringOn401(this.tokens, ctx.personId, async () => {
        const insert = (event: GoogleEventInput) =>
          this.google.insertEvent({ accessToken, calendarId: calendar.id, event });
        try {
          if (!calendar.primary) {
            await insert(allDay);
            return;
          }
          try {
            await insert(outOfOffice);
          } catch (error) {
            if (
              !(error instanceof GoogleApiError) ||
              (error.status !== 400 && error.status !== 403)
            )
              throw error;
            await insert(allDay);
          }
        } catch (error) {
          // 409: an earlier attempt already put the event there.
          if (error instanceof GoogleApiError && error.status === 409) return;
          throw error;
        }
      });
    }
    return { externalId: id };
  }

  async undo(externalId: string, spec: WriteSpec, ctx: ConnectorCtx): Promise<void> {
    const access = await this.tokens.accessFor(ctx.personId);
    if (!access.ok) throw new SkipWrite("Google isn't connected");
    const { calendars } = spec.args as CalendarWriteArgs;
    for (const calendar of calendars) {
      await expiringOn401(this.tokens, ctx.personId, () =>
        this.google.deleteEvent({
          accessToken: access.accessToken,
          calendarId: calendar.id,
          eventId: externalId,
        }),
      );
    }
  }
}
