import type { Block, ModalView } from "@steward/core/blocks";

export type DemoPerson = { slackUserId: string; displayName: string; tz: string };
export type DemoSessionInfo = {
  id: string;
  expiresAt: number;
  clockOffsetMs: number;
  you: DemoPerson | null;
  people: DemoPerson[];
};
export type SlackStatus = { text: string; emoji: string; expiration: number };
export type DemoEvent =
  | { seq: number; kind: "view"; at: number; payload: { triggerId: string; view: ModalView } }
  | {
      seq: number;
      kind: "response";
      at: number;
      payload: { responseUrl: string; text: string; blocks: Block[]; replaceOriginal: boolean };
    }
  | {
      seq: number;
      kind: "status";
      at: number;
      payload: { slackUserId: string; status: SlackStatus | null };
    };
export type DemoState = {
  now: number;
  expiresAt: number;
  clockOffsetMs: number;
  events: DemoEvent[];
};
export type SubmitAnswer =
  | { response_action: "clear" }
  | { response_action: "errors"; errors: Record<string, string> };

/** 404: the session expired or never existed. */
export class DemoGone extends Error {}
/** 429: no session to spare, or this visitor is sending requests too fast. The message is the backend's sentence when it sent one. */
export class DemoBusy extends Error {}
/** Anything else that is not a success. The message is the backend's own sentence when it sent one. */
export class DemoFailed extends Error {}

export type FetchFn = (path: string, init?: RequestInit) => Promise<Response>;
export type DemoApi = {
  createSession(tz: string): Promise<DemoSessionInfo>;
  getState(id: string): Promise<DemoState>;
  sendCommand(id: string, text: string): Promise<{ text: string }>;
  /** A form submission answers with JSON; a button press answers with nothing (null). */
  interact(id: string, payload: unknown): Promise<SubmitAnswer | null>;
  advance(id: string, minutes: number): Promise<DemoState>;
};

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  if (res.status === 404) throw new DemoGone("This demo session has ended.");
  let sentence: string | null = null;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") sentence = body.error;
  } catch {
    // not JSON: fall back to a sentence of our own
  }
  if (res.status === 429) throw new DemoBusy(sentence ?? "The demo is busy right now.");
  throw new DemoFailed(sentence ?? `The demo answered ${res.status}.`);
}

export function demoApi(fetchFn: FetchFn): DemoApi {
  const post = (path: string, body: unknown) =>
    fetchFn(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const json = async <T>(res: Promise<Response>): Promise<T> =>
    (await (await check(await res)).json()) as T;
  const at = (id: string, leaf: string) => `/demo/${encodeURIComponent(id)}/${leaf}`;
  return {
    createSession: (tz) => json<DemoSessionInfo>(post("/demo/sessions", { tz })),
    getState: (id) => json<DemoState>(fetchFn(at(id, "state"))),
    sendCommand: (id, text) => json<{ text: string }>(post(at(id, "command"), { text })),
    interact: async (id, payload) => {
      const res = await check(await post(at(id, "interact"), payload));
      const text = await res.text();
      return text ? (JSON.parse(text) as SubmitAnswer) : null;
    },
    advance: (id, minutes) => json<DemoState>(post(at(id, "advance"), { minutes })),
  };
}
