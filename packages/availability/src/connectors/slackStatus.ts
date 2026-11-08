import {
  type Connector,
  type ConnectorCtx,
  SkipWrite,
  type SlackClient,
  type WriteSpec,
} from "@steward/core";
import { SLACK_STATUS } from "../status/plan";

type Args = { text: string; emoji: string; expiration: number };

/** Sets and clears the person's own Slack status. Needs their user token (users.profile:write). */
export class SlackStatusConnector implements Connector {
  readonly system = SLACK_STATUS;
  constructor(private readonly slack: SlackClient) {}

  async perform(spec: WriteSpec, ctx: ConnectorCtx): Promise<{ externalId: string }> {
    if (!ctx.userToken)
      throw new SkipWrite("Slack isn't connected for you yet — use Connect Slack first");
    const { text, emoji, expiration } = spec.args as Args;
    await this.slack.setUserStatus({ userToken: ctx.userToken, text, emoji, expiration });
    return { externalId: `${ctx.personId}:${expiration}` };
  }

  async undo(_externalId: string, _spec: WriteSpec, ctx: ConnectorCtx): Promise<void> {
    if (!ctx.userToken) return;
    await this.slack.clearUserStatus({ userToken: ctx.userToken });
  }
}
