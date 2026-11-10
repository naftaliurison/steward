import type { ModalView } from "./blocks";
import {
  assertTrustedResponseUrl,
  type PostMessageArgs,
  type RespondArgs,
  type SetStatusArgs,
  SlackApiError,
  type SlackClient,
  type UserProfile,
} from "./client";

export type FakeStatus = { text: string; emoji: string; expiration: number };

/** In-memory Slack: records every call so tests and the demo can read what "Slack" now holds. */
export class FakeSlackClient implements SlackClient {
  openedViews: { triggerId: string; view: ModalView }[] = [];
  responses: RespondArgs[] = [];
  messages: PostMessageArgs[] = [];
  statuses = new Map<string, FakeStatus | null>();
  /** Seed with `users.set(slackUserId, { displayName, tz })`; unknown users answer null like Slack does. */
  users = new Map<string, UserProfile>();
  userInfoCalls: string[] = [];
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
    assertTrustedResponseUrl(args.responseUrl);
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

  async postMessage(args: PostMessageArgs): Promise<void> {
    this.maybeFail("postMessage");
    this.messages.push(args);
  }

  async getUserInfo(args: { botToken: string; userId: string }): Promise<UserProfile | null> {
    this.maybeFail("getUserInfo");
    this.userInfoCalls.push(args.userId);
    return this.users.get(args.userId) ?? null;
  }
}
