/** Offset of `tz` from UTC at the given instant, in ms (positive east of UTC). */
export function tzOffsetMs(epochMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** A local calendar date and HH:MM in `tz` → the instant, as epoch ms. The model never does this; this does. */
export function zonedTimeToEpochMs(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

export function todayIn(tz: string, nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

export function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function formatDay(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(epochMs));
}

export function formatTime(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochMs));
}

/** "Thu 12 Nov" for one day, "Thu 12 Nov – Tue 17 Nov" for a range; `endMs` is exclusive. */
export function formatRange(startMs: number, endMs: number, tz: string): string {
  const first = formatDay(startMs, tz);
  const last = formatDay(endMs - 1, tz);
  return first === last ? first : `${first} – ${last}`;
}
