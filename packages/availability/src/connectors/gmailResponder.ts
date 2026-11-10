import {
  type Connector,
  type ConnectorCtx,
  GOOGLE_SCOPE,
  type GoogleClient,
  type GoogleTokenSource,
  SkipWrite,
  type VacationSettings,
  type WriteSpec,
} from "@steward/core";
import { GMAIL_RESPONDER, type ResponderWriteArgs } from "../status/plan";
import { expiringOn401, googleAccessOrSkip } from "./googleAccess";

export const AUTO_REPLY_ALREADY_ON = "your Gmail auto-reply is already on — Steward left it alone";

/**
 * Steward's own: on, with this write's subject and text, compared with whitespace trimmed at both
 * ends. The times are left out on purpose: Gmail may hand them back rounded, and Steward would then
 * fail to recognise (and never turn off) its own auto-reply. The text carries the dates in words,
 * so it is specific to the status.
 */
function isOurs(current: VacationSettings, args: ResponderWriteArgs): boolean {
  return (
    current.enableAutoReply &&
    current.responseSubject.trim() === args.subject.trim() &&
    current.responseBodyPlainText.trim() === args.body.trim()
  );
}

/**
 * Turns the Gmail auto-reply on for the dates of the status, and off again on undo. Gmail has one
 * auto-reply per account: one the person set themselves is never overwritten, and one Steward did
 * not set is never turned off.
 */
export class GmailResponderConnector implements Connector {
  readonly system = GMAIL_RESPONDER;
  private readonly google: GoogleClient;
  private readonly tokens: GoogleTokenSource;

  constructor(deps: { google: GoogleClient; tokens: GoogleTokenSource }) {
    this.google = deps.google;
    this.tokens = deps.tokens;
  }

  async perform(spec: WriteSpec, ctx: ConnectorCtx): Promise<{ externalId: string }> {
    const args = spec.args as ResponderWriteArgs;
    const { accessToken } = await googleAccessOrSkip(
      this.tokens,
      ctx.personId,
      GOOGLE_SCOPE.gmailSettings,
    );
    const current = await expiringOn401(this.tokens, ctx.personId, () =>
      this.google.getVacation({ accessToken }),
    );
    const externalId = `${ctx.personId}:${args.startMs}`;
    if (current.enableAutoReply) {
      // An earlier attempt already wrote it: done. Anything else is the person's own.
      if (isOurs(current, args)) return { externalId };
      throw new SkipWrite(AUTO_REPLY_ALREADY_ON);
    }
    await expiringOn401(this.tokens, ctx.personId, () =>
      this.google.setVacation({
        accessToken,
        settings: {
          enableAutoReply: true,
          responseSubject: args.subject,
          responseBodyPlainText: args.body,
          startTime: args.startMs,
          endTime: args.endMs,
          restrictToContacts: current.restrictToContacts,
          restrictToDomain: current.restrictToDomain,
        },
      }),
    );
    return { externalId };
  }

  async undo(_externalId: string, spec: WriteSpec, ctx: ConnectorCtx): Promise<void> {
    const args = spec.args as ResponderWriteArgs;
    const access = await this.tokens.accessFor(ctx.personId);
    if (!access.ok) throw new SkipWrite("Google isn't connected");
    const current = await expiringOn401(this.tokens, ctx.personId, () =>
      this.google.getVacation({ accessToken: access.accessToken }),
    );
    // Changed or turned off since: it is the person's now.
    if (!isOurs(current, args)) return;
    await expiringOn401(this.tokens, ctx.personId, () =>
      this.google.setVacation({
        accessToken: access.accessToken,
        settings: { ...current, enableAutoReply: false },
      }),
    );
  }
}
