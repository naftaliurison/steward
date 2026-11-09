import {
  assertTrustedResponseUrl,
  type Db,
  type DemoEventRow,
  type ModalView,
  newId,
  type RespondArgs,
  type SetStatusArgs,
  type SlackClient,
  schema,
  type UserProfile,
} from "@steward/core";
import { eq, sql } from "drizzle-orm";

export type DemoEventKind = "view" | "response" | "status";

/**
 * The demo's Slack: every call becomes a `demo_events` row the emulator reads back.
 * Same interface and the same checks as the real client; nothing leaves the database.
 */
export class DemoSlackClient implements SlackClient {
  constructor(
    private readonly db: Db,
    private readonly sessionId: string,
    private readonly now: () => number,
  ) {}

  /**
   * One statement: the next number is worked out inside the INSERT itself, so two requests
   * recording at once cannot read the same maximum (the unique index backs this up).
   */
  private async record(kind: DemoEventKind, payload: unknown): Promise<void> {
    const sessionId = this.sessionId;
    const body = JSON.stringify(payload);
    const at = this.now();
    const id = newId();
    await this.db.insert(schema.demoEvents).select((qb) =>
      qb
        .select({
          id: sql<string>`${id}`.as("id"),
          sessionId: sql<string>`${sessionId}`.as("session_id"),
          seq: sql<number>`coalesce(max(${schema.demoEvents.seq}), 0) + 1`.as("seq"),
          kind: sql<string>`${kind}`.as("kind"),
          payload: sql<string>`${body}`.as("payload"),
          at: sql<number>`${at}`.as("at"),
        })
        .from(schema.demoEvents)
        .where(eq(schema.demoEvents.sessionId, sessionId)),
    );
  }

  async openView(args: {
    botToken: string;
    triggerId: string;
    view: ModalView;
  }): Promise<{ viewId: string }> {
    await this.record("view", { triggerId: args.triggerId, view: args.view });
    return { viewId: `V-demo-${args.triggerId}` };
  }

  async respond(args: RespondArgs): Promise<void> {
    assertTrustedResponseUrl(args.responseUrl);
    await this.record("response", {
      responseUrl: args.responseUrl,
      text: args.text,
      blocks: args.blocks ?? [],
      replaceOriginal: args.replaceOriginal ?? false,
    });
  }

  async setUserStatus(args: SetStatusArgs): Promise<void> {
    await this.record("status", {
      userToken: args.userToken,
      status: { text: args.text, emoji: args.emoji, expiration: args.expiration },
    });
  }

  async clearUserStatus(args: { userToken: string }): Promise<void> {
    await this.record("status", { userToken: args.userToken, status: null });
  }

  /** Demo people are seeded with their profile already synced, so this is not reached in practice. */
  async getUserInfo(_args: { botToken: string; userId: string }): Promise<UserProfile | null> {
    return null;
  }
}

export async function readDemoEvents(db: Db, sessionId: string): Promise<DemoEventRow[]> {
  return db
    .select()
    .from(schema.demoEvents)
    .where(eq(schema.demoEvents.sessionId, sessionId))
    .orderBy(schema.demoEvents.seq);
}
