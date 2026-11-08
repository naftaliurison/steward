import type { Block, ModalView } from "./blocks";

export type RespondArgs = {
  responseUrl: string;
  text: string;
  blocks?: Block[];
  responseType?: "ephemeral" | "in_channel";
  replaceOriginal?: boolean;
};

export type SetStatusArgs = {
  userToken: string;
  text: string;
  emoji: string;
  /** Unix seconds; 0 means no expiry. */
  expiration: number;
};

export type UserProfile = { displayName: string; tz: string };

type SlackUser = {
  name?: string;
  real_name?: string;
  tz?: string;
  profile?: { display_name?: string; real_name?: string };
};

export interface SlackClient {
  openView(args: {
    botToken: string;
    triggerId: string;
    view: ModalView;
  }): Promise<{ viewId: string }>;
  respond(args: RespondArgs): Promise<void>;
  setUserStatus(args: SetStatusArgs): Promise<void>;
  clearUserStatus(args: { userToken: string }): Promise<void>;
  /** The person's display name and IANA time zone, or null when Slack doesn't know the user. */
  getUserInfo(args: { botToken: string; userId: string }): Promise<UserProfile | null>;
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`${method}: ${code}`);
    this.name = "SlackApiError";
  }
}

type ApiResponse = { ok: boolean; error?: string } & Record<string, unknown>;

/** Slack answers JSON; an edge or outage page is not Slack and becomes a typed error. */
async function parseJson(res: Response, method: string): Promise<ApiResponse> {
  try {
    return (await res.json()) as ApiResponse;
  } catch {
    throw new SlackApiError(method, `http_${res.status}`);
  }
}

export class RealSlackClient implements SlackClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  private async call(
    method: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<ApiResponse> {
    const res = await this.fetchFn(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const data = await parseJson(res, method);
    if (!data.ok) throw new SlackApiError(method, data.error ?? "unknown_error");
    return data;
  }

  async openView(args: {
    botToken: string;
    triggerId: string;
    view: ModalView;
  }): Promise<{ viewId: string }> {
    const data = await this.call("views.open", args.botToken, {
      trigger_id: args.triggerId,
      view: args.view,
    });
    return { viewId: (data.view as { id: string }).id };
  }

  async respond(args: RespondArgs): Promise<void> {
    const res = await this.fetchFn(args.responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: args.text,
        blocks: args.blocks,
        response_type: args.responseType ?? "ephemeral",
        replace_original: args.replaceOriginal ?? false,
      }),
    });
    if (!res.ok) throw new SlackApiError("response_url", `http_${res.status}`);
  }

  async setUserStatus(args: SetStatusArgs): Promise<void> {
    await this.call("users.profile.set", args.userToken, {
      profile: {
        status_text: args.text,
        status_emoji: args.emoji,
        status_expiration: args.expiration,
      },
    });
  }

  async clearUserStatus(args: { userToken: string }): Promise<void> {
    await this.call("users.profile.set", args.userToken, {
      profile: { status_text: "", status_emoji: "", status_expiration: 0 },
    });
  }

  async getUserInfo(args: { botToken: string; userId: string }): Promise<UserProfile | null> {
    const url = new URL("https://slack.com/api/users.info");
    url.searchParams.set("user", args.userId);
    const res = await this.fetchFn(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${args.botToken}` },
    });
    const data = await parseJson(res, "users.info");
    if (!data.ok) {
      if (data.error === "user_not_found") return null;
      throw new SlackApiError("users.info", data.error ?? "unknown_error");
    }
    const user = (data.user ?? {}) as SlackUser;
    const displayName =
      user.profile?.display_name ||
      user.profile?.real_name ||
      user.real_name ||
      user.name ||
      args.userId;
    return { displayName, tz: user.tz || "UTC" };
  }
}
