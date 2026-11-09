import type { ModalView } from "@steward/core/blocks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockAction } from "../blockkit/Blocks";
import type { Values } from "../blockkit/values";
import {
  type DemoApi,
  DemoBusy,
  DemoFailed,
  DemoGone,
  type DemoPerson,
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
const FRESH_LOST_ACTION =
  "Your demo hour ended, so this is a fresh one. What you just did was not saved.";
const NO_ANSWER = "The demo didn't answer. Check your connection and try again.";
/** The error key a failed save is shown under: it names no field, so the form shows it at the top. */
const FORM_ERROR = "_form";
const EMPTY: Screen = { messages: [], openView: null, statuses: {} };
const NO_ERRORS: Record<string, string> = {};

type Saved = { info: DemoSessionInfo; closed: number[] };

function isPerson(value: unknown): value is DemoPerson {
  const p = value as Record<string, unknown> | null;
  return (
    typeof p === "object" &&
    p !== null &&
    typeof p.slackUserId === "string" &&
    typeof p.displayName === "string" &&
    typeof p.tz === "string"
  );
}

function readSaved(store: Store): Saved | null {
  try {
    const saved = JSON.parse(store.get(KEY) ?? "null") as {
      info?: Partial<DemoSessionInfo> | null;
      closed?: unknown;
    } | null;
    const info = saved?.info;
    if (
      info &&
      typeof info.id === "string" &&
      info.id !== "" &&
      typeof info.expiresAt === "number" &&
      Number.isFinite(info.expiresAt) &&
      Array.isArray(info.people) &&
      info.people.every(isPerson) &&
      (info.you === null || isPerson(info.you)) &&
      Array.isArray(saved.closed) &&
      saved.closed.every((n) => typeof n === "number")
    )
      return { info: info as DemoSessionInfo, closed: saved.closed as number[] };
  } catch {
    // unreadable: start a new session
  }
  store.remove(KEY);
  return null;
}

/** The backend's own sentence, when it sent one. */
const sentence = (err: unknown) =>
  err instanceof DemoFailed || err instanceof DemoBusy ? err.message : null;

export function useDemoSession(opts: { api: DemoApi; store: Store; tz: string }) {
  const { api, store, tz } = opts;
  const [phase, setPhase] = useState<Phase>("loading");
  const [failure, setFailure] = useState<string | null>(null);
  const [info, setInfo] = useState<DemoSessionInfo | null>(null);
  const [state, setState] = useState<DemoState | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<number>>(() => new Set());
  const [notices, setNotices] = useState<Notice[]>([]);
  const [formErrors, setFormErrors] = useState<{ seq: number; errors: Record<string, string> }>({
    seq: 0,
    errors: NO_ERRORS,
  });
  const [working, setWorking] = useState(false);
  const started = useRef(false);
  const lastSeq = useRef(0);
  const noticeId = useRef(0);
  /** Increased whenever a session begins, so a late answer from an earlier one can be told apart. */
  const generation = useRef(0);
  const closedSeqs = useRef<Set<number>>(new Set());

  const show = useCallback((next: DemoState) => {
    lastSeq.current = next.events.at(-1)?.seq ?? 0;
    setState(next);
  }, []);

  const notify = useCallback((text: string) => {
    noticeId.current += 1;
    const notice: Notice = { id: noticeId.current, afterSeq: lastSeq.current, text };
    setNotices((all) => [...all, notice]);
  }, []);

  const fail = useCallback((err: unknown) => {
    setFailure(sentence(err));
    setPhase(err instanceof DemoBusy ? "busy" : "failed");
  }, []);

  /** Starts a session on purpose. The new session is saved as soon as it exists, so a retry restores it. */
  const begin = useCallback(
    async (note?: string) => {
      generation.current += 1;
      const gen = generation.current;
      setWorking(false);
      setPhase("loading");
      let fresh: DemoSessionInfo;
      try {
        fresh = await api.createSession(tz);
      } catch (err) {
        if (gen === generation.current) fail(err);
        return;
      }
      if (gen !== generation.current) return;
      store.set(KEY, JSON.stringify({ info: fresh, closed: [] }));
      try {
        const first = await api.getState(fresh.id);
        if (gen !== generation.current) return;
        closedSeqs.current = new Set();
        setInfo(fresh);
        setClosed(new Set());
        setNotices([]);
        show(first);
        if (note) notify(note);
        setPhase("ready");
      } catch (err) {
        if (gen === generation.current) fail(err);
      }
    },
    [api, tz, store, show, notify, fail],
  );

  /** Picks the saved session up again; only a session that is gone is replaced. */
  const retry = useCallback(async () => {
    const saved = readSaved(store);
    if (!saved) return begin();
    generation.current += 1;
    const gen = generation.current;
    setWorking(false);
    setPhase("loading");
    try {
      const current = await api.getState(saved.info.id);
      if (gen !== generation.current) return;
      closedSeqs.current = new Set(saved.closed);
      setInfo(saved.info);
      setClosed(new Set(saved.closed));
      setNotices([]);
      show(current);
      setPhase("ready");
    } catch (err) {
      if (gen !== generation.current) return;
      if (err instanceof DemoGone) {
        store.remove(KEY);
        await begin(FRESH);
      } else fail(err);
    }
  }, [api, store, begin, show, fail]);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in development
    started.current = true;
    void retry();
  }, [retry]);

  useEffect(() => {
    if (info) store.set(KEY, JSON.stringify({ info, closed: [...closed] }));
  }, [info, closed, store]);

  /** Runs one request at a time, then shows the state it left behind. A late answer from an earlier session is dropped. */
  const run = useCallback(
    async (
      work: (id: string, live: () => boolean) => Promise<DemoState | undefined>,
      onFailure?: (message: string) => void,
    ) => {
      if (!info || working) return;
      const gen = generation.current;
      const live = () => gen === generation.current;
      setWorking(true);
      try {
        const next = (await work(info.id, live)) ?? (await api.getState(info.id));
        if (live()) show(next);
      } catch (err) {
        if (!live()) return;
        if (err instanceof DemoGone) {
          store.remove(KEY);
          await begin(FRESH_LOST_ACTION);
        } else {
          // A refusal (a cap reached, too many requests) carries the backend's own sentence.
          const message = sentence(err) ?? NO_ANSWER;
          if (onFailure) onFailure(message);
          else notify(message);
        }
      } finally {
        if (live()) setWorking(false);
      }
    },
    [api, store, info, working, begin, show, notify],
  );

  const closeView = useCallback((seq: number) => {
    closedSeqs.current.add(seq);
    setClosed((all) => new Set([...all, seq]));
    setFormErrors({ seq: 0, errors: NO_ERRORS });
  }, []);

  const command = useCallback(
    (text: string) =>
      run(async (id, live) => {
        const answer = await api.sendCommand(id, text);
        if (answer.text && live()) notify(answer.text); // the product's own immediate reply, shown as it is
        return undefined;
      }),
    [api, run, notify],
  );

  const submit = useCallback(
    (open: { seq: number; view: ModalView }, values: Values) => {
      /** Only a form that is still open shows an answer. */
      const showErrors = (errors: Record<string, string>) => {
        if (!closedSeqs.current.has(open.seq)) setFormErrors({ seq: open.seq, errors });
      };
      setFormErrors({ seq: open.seq, errors: NO_ERRORS });
      return run(
        async (id, live) => {
          const answer = await api.interact(id, viewSubmission(open.view, values));
          if (!live()) return undefined;
          if (answer?.response_action === "errors") showErrors(answer.errors);
          else closeView(open.seq);
          return undefined;
        },
        (message) => showErrors({ [FORM_ERROR]: message }),
      );
    },
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
  // A new form always starts with no errors: they belong to the form they were answered for.
  const errors = screen.openView?.seq === formErrors.seq ? formErrors.errors : NO_ERRORS;

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
    retry,
  };
}
