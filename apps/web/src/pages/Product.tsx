import { useEffect, useState } from "react";

export const REPO_URL = "https://github.com/naftaliurison/steward";
const DESIGN_URL = `${REPO_URL}/blob/main/docs/superpowers/specs/2026-11-08-steward-availability-design.md`;

const PRIMARY = "rounded bg-emerald-700 px-4 py-2 font-bold text-white";
const SECONDARY = "rounded border border-neutral-400 px-4 py-2 font-bold";
const SECTION_HEADING = "text-xl font-extrabold";

const WORKS_TODAY = [
  "Type /ooo in Slack and a short form opens: what is happening, from when, until when.",
  "Save sets your Slack status until your last day ends, in your own time zone.",
  "A receipt lists each change Steward made, with an Undo button that works for five minutes.",
  "Nothing is written until you press Save, and every write is recorded.",
];
const COMING_NEXT = [
  "Google Calendar out-of-office and the Gmail auto-reply, set and undone together with the status.",
  "Dates in the future, and requests in plain words.",
  "A team view of who is away.",
  "Finding a time for a group and booking it with an agenda.",
];

export function Product({ installable }: { installable: boolean }) {
  return (
    <div className="min-h-dvh bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <main className="mx-auto max-w-2xl space-y-12 px-4 py-16">
        <section>
          <p className="font-bold text-emerald-700">Steward</p>
          <h1 className="mt-1 text-4xl font-extrabold">Steward Availability</h1>
          <p className="mt-4 text-lg">
            Say once that you are out, sick, remote or travelling. Steward sets your Slack status,
            shows you a receipt of what it changed, and lets you undo it.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a className={PRIMARY} href="/try">
              Try the demo
            </a>
            {installable ? (
              <a className={SECONDARY} href="/oauth/slack/install">
                Add to Slack
              </a>
            ) : null}
            <a className={SECONDARY} href={REPO_URL}>
              Read the code
            </a>
          </div>
          <p className="mt-3 text-sm text-neutral-500">
            The demo runs in your browser against a pretend Slack. No sign-up, and nothing you do
            there leaves it.
          </p>
        </section>

        <section>
          <h2 className={SECTION_HEADING}>What works today</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            {WORKS_TODAY.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className={SECTION_HEADING}>Coming next</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            {COMING_NEXT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className={SECTION_HEADING}>How it is built</h2>
          <p className="mt-3">
            One TypeScript codebase on Cloudflare Workers with a D1 database. Every write goes
            through one engine that records what it did and knows how to reverse it. The demo on
            this site runs that same code against a pretend Slack.
          </p>
          <p className="mt-3">
            <a className="underline" href={DESIGN_URL}>
              Read the design
            </a>
          </p>
        </section>
      </main>
      <footer className="mx-auto max-w-2xl space-y-1 px-4 pb-10 text-sm text-neutral-500">
        <p>Source available under the Business Source License 1.1.</p>
        <p>The demo uses Slack-inspired styling. Steward is not affiliated with Slack.</p>
      </footer>
    </div>
  );
}

/** The page as served: asks the Worker once whether the Slack install flow is configured. */
export function ProductPage({ health }: { health: () => Promise<{ slack?: boolean }> }) {
  const [installable, setInstallable] = useState(false);
  useEffect(() => {
    let live = true;
    health()
      .then((body) => {
        if (live) setInstallable(body.slack === true);
      })
      .catch(() => {
        // /health unreachable: keep the page without "Add to Slack"
      });
    return () => {
      live = false;
    };
  }, [health]);
  return <Product installable={installable} />;
}
