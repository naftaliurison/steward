import type { ModalView } from "@steward/core/blocks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockAction } from "../blockkit/Blocks";
import type { Values } from "../blockkit/values";
import {
  type DemoApi,
  DemoBusy,
  DemoFailed,
  DemoGone,
  type DemoSessionInfo,
  type DemoState,
} from "./api";
import { deriveScreen, type Notice, type Screen } from "./model";
import { blockAction, viewSubmission } from "./payloads";

/** Where the session id survives a reload. The page passes sessionStorage; tests pass a Map. */
export type Store = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};
export type Phase = "loading" | "ready" | "busy" | "failed";

const KEY = "steward.demo";
const FRESH = "Your demo hour ended, so this is a fresh one.";
const NO_ANSWER = "The demo didn't answer. Check your connection and try again.";
const EMPTY: Screen = { messages: [], openView: null, statuses: {} };

type Saved = { info: DemoSessionInfo; closed: number[] };

function readSaved(store: Store): Saved | null {
  try {
    const saved = JSON.parse(store.get(KEY) ?? "null") as Partial<Saved> | null;
    if (saved?.info && typeof saved.info.id === "string" && Array.isArray(saved.closed))
      return { info: saved.info, closed: saved.closed.filter((n) => typeof n === "number") };
  } catch {
    // unreadable: start a new session
  }
  return null;
}

export function useDemoSession(opts: { api: DemoApi; store: Store; tz: string }) {
  const { api, store, tz } = opts;
  const [phase, setPhase] = useState<Phase>("loading");
  const [failure, setFailure] = useState<string | null>(null);
  const [info, setInfo] = useState<DemoSessionInfo | null>(null);
  const [state, setState] = useState<DemoState | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<number>>(() => new Set());
  const [notices, setNotices] = useState<Notice[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const started = useRef(false);
  const lastSeq = useRef(0);
  const noticeId = useRef(0);

  const show = useCallback((next: DemoState) => {
    lastSeq.current = next.events.at(-1)?.seq ?? 0;
    setState(next);
  }, []);

  const notify = useCallback((text: string) => {
    noticeId.current += 1;
    const notice: Notice = { id: noticeId.current, afterSeq: lastSeq.current, text };
    setNotices((all) => [...all, notice]);
  }, []);

  const begin = useCallback(
    async (note?: string) => {
      setPhase("loading");
      try {
        const fresh = await api.createSession(tz);
        const first = await api.getState(fresh.id);
        setInfo(fresh);
        setClosed(new Set());
        setErrors({});
        setNotices([]);
        show(first);
        if (note) notify(note);
        setPhase("ready");
      } catch (err) {
        // A refusal carries the backend's own sentence (for example when the demo is switched off).
        setFailure(err instanceof DemoFailed ? err.message : null);
        setPhase(err instanceof DemoBusy ? "busy" : "failed");
      }
    },
    [api, tz, show, notify],
  );

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in development
    started.current = true;
    void (async () => {
      const saved = readSaved(store);
      if (!saved) return begin();
      try {
        const current = await api.getState(saved.info.id);
        setInfo(saved.info);
        setClosed(new Set(saved.closed));
        show(current);
        setPhase("ready");
      } catch (err) {
        if (!(err instanceof DemoGone)) return setPhase("failed");
        store.remove(KEY);
        await begin(FRESH);
      }
    })();
  }, [api, store, begin, show]);

  useEffect(() => {
    if (info) store.set(KEY, JSON.stringify({ info, closed: [...closed] }));
  }, [info, closed, store]);

  /** Runs one request at a time, then shows the state it left behind. */
  const run = useCallback(
    async (work: (id: string) => Promise<DemoState | undefined>) => {
      if (!info || working) return;
      setWorking(true);
      try {
        show((await work(info.id)) ?? (await api.getState(info.id)));
      } catch (err) {
        if (err instanceof DemoGone) {
          store.remove(KEY);
          await begin(FRESH);
        } else {
          // A refusal (a cap reached, too many requests) carries the backend's own sentence.
          const refused = err instanceof DemoFailed || err instanceof DemoBusy;
          notify(refused ? err.message : NO_ANSWER);
        }
      } finally {
        setWorking(false);
      }
    },
    [api, store, info, working, begin, show, notify],
  );

  const closeView = useCallback((seq: number) => {
    setClosed((all) => new Set([...all, seq]));
    setErrors({});
  }, []);

  const command = useCallback(
    (text: string) =>
      run(async (id) => {
        setErrors({});
        const answer = await api.sendCommand(id, text);
        if (answer.text) notify(answer.text); // the product's own immediate reply, shown as it is
        return undefined;
      }),
    [api, run, notify],
  );

  const submit = useCallback(
    (open: { seq: number; view: ModalView }, values: Values) =>
      run(async (id) => {
        const answer = await api.interact(id, viewSubmission(open.view, values));
        if (answer?.response_action === "errors") setErrors(answer.errors);
        else closeView(open.seq);
        return undefined;
      }),
    [api, run, closeView],
  );

  const press = useCallback(
    (action: BlockAction, messageSeq: number) =>
      run(async (id) => {
        await api.interact(id, blockAction(action, messageSeq));
        return undefined;
      }),
    [api, run],
  );

  const advance = useCallback(
    (minutes: number) => run((id) => api.advance(id, minutes)),
    [api, run],
  );

  const restart = useCallback(async () => {
    store.remove(KEY);
    await begin();
  }, [store, begin]);

  const screen = useMemo(() => (state ? deriveScreen(state, closed) : EMPTY), [state, closed]);

  return {
    phase,
    failure,
    info,
    screen,
    now: state?.now ?? 0,
    notices,
    errors,
    working,
    command,
    submit,
    press,
    advance,
    closeView,
    restart,
  };
}
