// @vitest-environment jsdom
import {
  actions,
  button,
  context,
  datepicker,
  header,
  input,
  type ModalView,
  option,
  plain,
  section,
  staticSelect,
  textInput,
} from "@steward/core/blocks";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DemoApi,
  DemoBusy,
  type DemoEvent,
  DemoFailed,
  DemoGone,
  type DemoSessionInfo,
  type DemoState,
} from "./api";
import { Emulator } from "./Emulator";
import type { Store } from "./useDemoSession";

afterEach(cleanup);

const START = Date.UTC(2026, 10, 12, 8, 0); // Thu 12 Nov 2026, 08:00 in London
const BASE = "https://hooks.slack.com/demo/s1";
const people = [
  { slackUserId: "U_DANA", displayName: "Dana", tz: "Europe/London" },
  { slackUserId: "U_OMER", displayName: "Omer", tz: "America/New_York" },
  { slackUserId: "U_NOA", displayName: "Noa", tz: "Asia/Jerusalem" },
];
const info: DemoSessionInfo = {
  id: "s1",
  expiresAt: START + 3_600_000,
  clockOffsetMs: 0,
  you: people[0] ?? null,
  people,
};
const form: ModalView = {
  type: "modal",
  callback_id: "ooo_status",
  title: plain("Set your availability"),
  submit: plain("Save"),
  close: plain("Cancel"),
  blocks: [
    input(
      "type",
      "What's happening?",
      staticSelect("type", [option("Out of office", "out")], option("Out of office", "out")),
    ),
    input("from", "From", datepicker("from", "2026-11-12")),
    input("to", "To (last day)", datepicker("to", "2026-11-12")),
    input("text", "Status text", textInput("text", "Out of office"), true),
  ],
};
const TITLE = "Out of office · Thu 12 Nov";

/** A scripted stand-in for the backend. The real one is covered by the Worker's webContract test. */
function fakeApi() {
  const events: DemoEvent[] = [];
  let now = START;
  let seq = 0;
  const state = (): DemoState => ({
    now,
    expiresAt: info.expiresAt,
    clockOffsetMs: 0,
    events: [...events],
  });
  const api: DemoApi = {
    createSession: vi.fn<DemoApi["createSession"]>(async () => info),
    getState: vi.fn<DemoApi["getState"]>(async () => state()),
    sendCommand: vi.fn<DemoApi["sendCommand"]>(async (_id, text) => {
      if (!text.startsWith("/ooo")) throw new DemoFailed("Only /ooo is available in the demo.");
      events.push({
        seq: ++seq,
        at: now,
        kind: "view",
        payload: { triggerId: `t${seq}`, view: form },
      });
      return { text: "" };
    }),
    interact: vi.fn<DemoApi["interact"]>(async (_id, payload) => {
      const sent = payload as {
        type: string;
        container?: { message_ts: string };
        view?: {
          state: { values: Record<string, Record<string, { selected_date?: string | null }>> };
        };
      };
      if (sent.type === "view_submission") {
        if (sent.view?.state.values.to?.to?.selected_date === "2000-01-01")
          return { response_action: "errors", errors: { to: "The last day has already passed." } };
        const status = {
          text: "Out of office",
          emoji: ":palm_tree:",
          expiration: Date.UTC(2026, 10, 13) / 1000,
        };
        events.push({
          seq: ++seq,
          at: now,
          kind: "status",
          payload: { slackUserId: "U_DANA", status },
        });
        const blocks = [
          header(TITLE),
          section("✅ Slack status set — clears Thu 12 Nov"),
          actions(button("Undo", "status_undo", { value: "st_1", style: "danger" })),
          context("You can undo until 08:05."),
        ];
        events.push({
          seq: ++seq,
          at: now,
          kind: "response",
          payload: { responseUrl: BASE, text: TITLE, blocks, replaceOriginal: false },
        });
        return { response_action: "clear" };
      }
      events.push({
        seq: ++seq,
        at: now,
        kind: "status",
        payload: { slackUserId: "U_DANA", status: null },
      });
      events.push({
        seq: ++seq,
        at: now,
        kind: "response",
        payload: {
          responseUrl: `${BASE}/${sent.container?.message_ts ?? ""}`,
          text: `Undone · ${TITLE}`,
          blocks: [header(`Undone · ${TITLE}`), section("↩️ Slack status cleared")],
          replaceOriginal: true,
        },
      });
      return null;
    }),
    advance: vi.fn<DemoApi["advance"]>(async (_id, minutes) => {
      now += minutes * 60_000;
      return state();
    }),
  };
  return api;
}

function memoryStore(seed?: string): Store {
  const map = new Map<string, string>(seed ? [["steward.demo", seed]] : []);
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

async function open(api: DemoApi, store: Store = memoryStore()) {
  render(<Emulator api={api} store={store} tz="Europe/London" />);
  return screen.findByRole("textbox", { name: "Message Steward" });
}
function send(box: HTMLElement, text: string) {
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("Emulator", () => {
  it("runs /ooo from the composer to a receipt, then undoes it on the card it came from", async () => {
    const api = fakeApi();
    send(await open(api), "/ooo");
    await screen.findByRole("dialog", { name: "Set your availability" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("heading", { name: TITLE });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("🌴 Out of office · until Thu 12 Nov")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByRole("heading", { name: `Undone · ${TITLE}` });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getAllByText("No status set")).toHaveLength(3);
    // view = 1, status = 2, receipt = 3: the press names message 3.
    expect(api.interact).toHaveBeenLastCalledWith(
      "s1",
      expect.objectContaining({
        type: "block_actions",
        container: { type: "message", message_ts: "3" },
      }),
    );
  });

  it("keeps the form open and shows the backend's error under its field", async () => {
    const api = fakeApi();
    send(await open(api), "/ooo");
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("To (last day)"), { target: { value: "2000-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The last day has already passed.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes the form on Cancel and does not reopen it", async () => {
    const api = fakeApi();
    send(await open(api), "/ooo");
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says the backend's own sentence when a command is refused", async () => {
    const api = fakeApi();
    send(await open(api), "hello");
    expect(await screen.findByText(/Only \/ooo is available in the demo\./)).toBeTruthy();
  });

  it("moves the clock forward", async () => {
    const api = fakeApi();
    await open(api);
    expect(screen.getByText("Thu 12 Nov, 08:00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+1 day" }));
    expect(await screen.findByText("Fri 13 Nov, 08:00")).toBeTruthy();
    expect(api.advance).toHaveBeenCalledWith("s1", 1440);
  });

  it("picks a saved session up again after a reload", async () => {
    const api = fakeApi();
    await open(api, memoryStore(JSON.stringify({ info, closed: [] })));
    expect(api.getState).toHaveBeenCalledWith("s1");
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("starts a fresh session, and says so, when the saved one has expired", async () => {
    const api = fakeApi();
    const fresh = api.getState;
    api.getState = vi
      .fn<DemoApi["getState"]>()
      .mockRejectedValueOnce(new DemoGone("gone"))
      .mockImplementation(fresh);
    await open(api, memoryStore(JSON.stringify({ info: { ...info, id: "old" }, closed: [] })));
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Your demo hour ended, so this is a fresh one\./)).toBeTruthy();
  });

  it("says so when the demo is busy, and can try again", async () => {
    const api = fakeApi();
    api.createSession = vi
      .fn<DemoApi["createSession"]>()
      .mockRejectedValueOnce(new DemoBusy("busy"))
      .mockResolvedValue(info);
    render(<Emulator api={api} store={memoryStore()} tz="Europe/London" />);
    expect(
      await screen.findByText("The demo is busy right now. Try again in a few minutes."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("textbox", { name: "Message Steward" })).toBeTruthy();
  });

  it("says the backend's own sentence when the demo cannot start", async () => {
    const api = fakeApi();
    api.createSession = vi
      .fn<DemoApi["createSession"]>()
      .mockRejectedValue(new DemoFailed("The demo is switched off."));
    render(<Emulator api={api} store={memoryStore()} tz="Europe/London" />);
    expect(await screen.findByText("The demo is switched off.")).toBeTruthy();
  });

  it("carries the note that it is not Slack", async () => {
    await open(fakeApi());
    expect(
      screen.getByText("Slack-inspired styling. Steward is not affiliated with Slack."),
    ).toBeTruthy();
  });
});
