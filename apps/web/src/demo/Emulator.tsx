import type { ModalView } from "@steward/core/blocks";
import { type FormEvent, type ReactNode, useState } from "react";
import { Blocks } from "../blockkit/Blocks";
import { Modal } from "../blockkit/Modal";
import { initialValues, type Values } from "../blockkit/values";
import type { DemoApi } from "./api";
import { formatDay, formatTime, statusLine, thread } from "./model";
import { type Store, useDemoSession } from "./useDemoSession";

const PANEL_BUTTON =
  "rounded border border-neutral-400 px-2 py-1 text-sm font-bold disabled:opacity-50";
const PANEL_HEADING = "text-xs font-bold uppercase tracking-wide text-neutral-500";
const RULE = "border-neutral-200 dark:border-neutral-700";
const STEPS = [
  { label: "+5 min", minutes: 5 },
  { label: "+1 hour", minutes: 60 },
  { label: "+1 day", minutes: 1440 },
] as const;

/** The open form. Keyed by the view's seq, so a new form starts from its own initial values. */
function OpenForm(props: {
  open: { seq: number; view: ModalView };
  errors: Record<string, string>;
  busy: boolean;
  onSubmit: (values: Values) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Values>(() => initialValues(props.open.view));
  return (
    <Modal
      view={props.open.view}
      values={values}
      errors={props.errors}
      busy={props.busy}
      onChange={(blockId, value) => setValues((all) => ({ ...all, [blockId]: value }))}
      onSubmit={() => props.onSubmit(values)}
      onClose={props.onClose}
    />
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-dvh flex-col items-center justify-center bg-white p-6 text-center text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {children}
    </main>
  );
}

export function Emulator(props: { api: DemoApi; store: Store; tz: string }) {
  const demo = useDemoSession(props);
  const [draft, setDraft] = useState("");

  if (demo.phase === "loading")
    return (
      <Centered>
        <p role="status">Starting your demo…</p>
      </Centered>
    );
  if (demo.phase !== "ready" || !demo.info)
    return (
      <Centered>
        <p role="alert">
          {demo.phase === "busy"
            ? (demo.failure ?? "The demo is busy right now. Try again in a few minutes.")
            : (demo.failure ?? "The demo couldn't start. Check your connection and try again.")}
        </p>
        <button type="button" className={`${PANEL_BUTTON} mt-4`} onClick={() => void demo.retry()}>
          Try again
        </button>
      </Centered>
    );

  const { info } = demo;
  const tz = info.you?.tz ?? props.tz;
  const items = thread(demo.screen.messages, demo.notices);
  const open = demo.screen.openView;

  const onSend = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void demo.command(text);
  };

  return (
    <div className="flex h-dvh flex-col bg-white text-neutral-900 md:flex-row dark:bg-neutral-900 dark:text-neutral-100">
      <nav
        aria-label="Workspace"
        className="hidden w-56 shrink-0 bg-slate-900 p-4 text-slate-300 md:block"
      >
        <p className="text-lg font-extrabold text-white">Acme</p>
        <p className="mt-4 text-xs uppercase tracking-wide text-slate-400">Channels</p>
        <p className="mt-1 px-2"># general</p>
        <p className="mt-4 text-xs uppercase tracking-wide text-slate-400">Direct messages</p>
        <p className="mt-1 rounded bg-slate-700 px-2 py-1 font-bold text-white">Steward</p>
        {info.people.map((person) => (
          <p key={person.slackUserId} className="mt-1 px-2">
            {person.slackUserId === info.you?.slackUserId
              ? `${person.displayName} (you)`
              : person.displayName}
          </p>
        ))}
      </nav>

      <main className="flex min-h-0 flex-1 flex-col">
        <header className={`border-b px-4 py-3 ${RULE}`}>
          <h1 className="font-extrabold">Steward</h1>
        </header>
        <ol
          aria-label="Messages"
          aria-live="polite"
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
        >
          {items.length === 0 ? (
            <li className="text-neutral-500">
              This is your direct message with Steward. Type /ooo to tell it you are away.
            </li>
          ) : null}
          {items.map((item) =>
            item.kind === "notice" ? (
              <li key={item.key} className="text-sm text-neutral-500">
                <span className="italic">Only visible to you · </span>
                <span>{item.text}</span>
              </li>
            ) : (
              <li key={item.key} className="flex gap-3">
                <div aria-hidden="true" className="h-9 w-9 shrink-0 rounded bg-emerald-700" />
                <div className="min-w-0">
                  <p className="text-sm">
                    <span className="font-bold">Steward </span>
                    <span className="text-xs text-neutral-500">
                      {`${formatTime(item.message.at, tz)} · Only visible to you`}
                    </span>
                  </p>
                  {item.message.blocks.length > 0 ? (
                    <Blocks
                      blocks={item.message.blocks}
                      disabled={demo.working}
                      onAction={(action) => void demo.press(action, item.message.seq)}
                    />
                  ) : (
                    <p>{item.message.text}</p>
                  )}
                </div>
              </li>
            ),
          )}
        </ol>
        <form onSubmit={onSend} className={`flex gap-2 border-t p-3 ${RULE}`}>
          <input
            aria-label="Message Steward"
            className="min-w-0 flex-1 rounded border border-neutral-400 bg-white px-3 py-2 dark:bg-neutral-800"
            placeholder="Type /ooo and press Enter"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="submit"
            disabled={demo.working}
            className="rounded bg-emerald-700 px-4 py-2 font-bold text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </main>

      <aside
        aria-label="Behind the scenes"
        className={`max-h-[40dvh] w-full shrink-0 space-y-5 overflow-y-auto border-t p-4 md:max-h-none md:w-72 md:border-t-0 md:border-l ${RULE}`}
      >
        <div>
          <h2 className="font-extrabold">Behind the scenes</h2>
          <p className="text-sm text-neutral-500">
            What Steward has written to this pretend Slack.
          </p>
        </div>
        <section>
          <h3 className={PANEL_HEADING}>Slack status</h3>
          <ul className="mt-1 space-y-2">
            {info.people.map((person) => (
              <li key={person.slackUserId}>
                <p className="font-bold">{person.displayName}</p>
                <p>{statusLine(demo.screen.statuses[person.slackUserId], person.tz)}</p>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className={PANEL_HEADING}>Clock</h3>
          <p className="mt-1">{`${formatDay(demo.now, tz)}, ${formatTime(demo.now, tz)}`}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {STEPS.map((step) => (
              <button
                key={step.label}
                type="button"
                className={PANEL_BUTTON}
                disabled={demo.working}
                onClick={() => void demo.advance(step.minutes)}
              >
                {step.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm text-neutral-500">
            Move time forward to watch the undo window close and the status expire.
          </p>
        </section>
        <section>
          <h3 className={PANEL_HEADING}>Session</h3>
          <p className="mt-1 text-sm">{`This demo ends at ${formatTime(info.expiresAt, tz)} by your own clock.`}</p>
          <button
            type="button"
            disabled={demo.working}
            className={`${PANEL_BUTTON} mt-2`}
            onClick={() => void demo.restart()}
          >
            Start over
          </button>
        </section>
        <p className="text-xs text-neutral-500">
          Slack-inspired styling. Steward is not affiliated with Slack.
        </p>
      </aside>

      {open ? (
        <OpenForm
          key={open.seq}
          open={open}
          errors={demo.errors}
          busy={demo.working}
          onSubmit={(values) => void demo.submit(open, values)}
          onClose={() => demo.closeView(open.seq)}
        />
      ) : null}
    </div>
  );
}
