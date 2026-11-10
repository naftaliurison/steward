export const REPO_URL = "https://github.com/naftaliurison/steward";
const DESIGN_URL = `${REPO_URL}/blob/main/docs/superpowers/specs/2026-11-08-steward-availability-design.md`;

const PRIMARY = "rounded bg-emerald-700 px-4 py-2 font-bold text-white";
const SECONDARY = "rounded border border-neutral-500 px-4 py-2 font-bold";
const SECTION_HEADING = "text-xl font-extrabold";

const WORKS_TODAY = [
  "Type /ooo in Slack and a short form opens: what is happening, and until which day.",
  "Once you have connected Steward to your Slack account, Save sets your Slack status until your last day ends, in your own time zone.",
  "A receipt lists each change Steward made, with an Undo button that works for five minutes.",
  "Pick a first day in the future and Steward sets the status when that day begins. Until then you can cancel it.",
  "If Slack refuses a change, Steward tries again for about half an hour, then tells you.",
  "No status is set until you press Save, and every write is recorded.",
];
const COMING_NEXT = [
  "Google Calendar out-of-office and the Gmail auto-reply, set and undone together with the status.",
  "Requests in plain words.",
  "A team view of who is away.",
  "Finding a time for a group and booking it with an agenda.",
];

export function Product() {
  return (
    <div className="min-h-dvh bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <main className="mx-auto max-w-2xl space-y-12 px-4 py-16">
        <section>
          <p className="font-bold text-emerald-700 dark:text-emerald-400">Steward</p>
          <h1 className="mt-1 text-4xl font-extrabold">Steward Availability</h1>
          <p className="mt-4 text-lg">
            Say once that you are out, sick, remote or travelling. Steward sets your Slack status,
            shows you a receipt of what it changed, and lets you undo it.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a className={PRIMARY} href="/try">
              Try the demo
            </a>
            <a className={SECONDARY} href={REPO_URL}>
              Read the code
            </a>
          </div>
          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
            The demo needs no sign-up. It runs the real code against a pretend Slack, not yours.
            What you enter there is kept on this site for up to an hour, then deleted.
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
      <footer className="mx-auto max-w-2xl space-y-1 px-4 pb-10 text-sm text-neutral-500 dark:text-neutral-400">
        <p>Source available under the Business Source License 1.1.</p>
        <p>The demo uses Slack-inspired styling. Steward is not affiliated with Slack.</p>
      </footer>
    </div>
  );
}
