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
import { eq, max } from "drizzle-orm";

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

  private async record(kind: DemoEventKind, payload: unknown): Promise<void> {
    const [row] = await this.db
      .select({ seq: max(schema.demoEvents.seq) })
      .from(schema.demoEvents)
      .where(eq(schema.demoEvents.sessionId, this.sessionId));
    const seq = (row?.seq ?? 0) + 1;
    await this.db.insert(schema.demoEvents).values({
      id: newId(),
      sessionId: this.sessionId,
      seq,
      kind,
      payload: JSON.stringify(payload),
      at: this.now(),
    });
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
