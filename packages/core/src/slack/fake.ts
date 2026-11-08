import type { ModalView } from "./blocks";
import { type RespondArgs, type SetStatusArgs, SlackApiError, type SlackClient } from "./client";

export type FakeStatus = { text: string; emoji: string; expiration: number };

/** In-memory Slack: records every call so tests and the demo can read what "Slack" now holds. */
export class FakeSlackClient implements SlackClient {
  openedViews: { triggerId: string; view: ModalView }[] = [];
  responses: RespondArgs[] = [];
  statuses = new Map<string, FakeStatus | null>();
  /** Set a method name to a Slack error code to make its next call fail once. */
  failNext: Partial<Record<keyof SlackClient, string>> = {};

  private maybeFail(method: keyof SlackClient): void {
    const code = this.failNext[method];
    if (code) {
      delete this.failNext[method];
      throw new SlackApiError(method, code);
    }
  }

  async openView(args: {
    botToken: string;
    triggerId: string;
    view: ModalView;
  }): Promise<{ viewId: string }> {
    this.maybeFail("openView");
    this.openedViews.push({ triggerId: args.triggerId, view: args.view });
    return { viewId: `V${this.openedViews.length}` };
  }

  async respond(args: RespondArgs): Promise<void> {
    this.maybeFail("respond");
    this.responses.push(args);
  }

  async setUserStatus(args: SetStatusArgs): Promise<void> {
    this.maybeFail("setUserStatus");
    this.statuses.set(args.userToken, {
      text: args.text,
      emoji: args.emoji,
      expiration: args.expiration,
    });
  }

  async clearUserStatus(args: { userToken: string }): Promise<void> {
    this.maybeFail("clearUserStatus");
    this.statuses.set(args.userToken, null);
  }
}
