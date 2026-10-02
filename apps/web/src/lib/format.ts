/**
 * Counting and time, the way the portal says them.
 *
 * One module so that "1 candidate(s)" cannot creep back in one screen at a
 * time, and every timestamp in the Jobs module reads the same way:
 * "25 Sep 2026, 5:07 pm" — no seconds, the month as a short word.
 *
 * Dependency-free and safe in both server and client components.
 */

/** "1 candidate", "3 candidates". Pass the plural when it is not just +s. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The noun alone, for sentences that put the number somewhere else. */
export function noun(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

// Fixed rather than taken from Intl: newer ICU data spells September "Sept" in
// en-GB, and the format is specified with three-letter months.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface Parts {
  day: number;
  month: string;
  year: number;
  hour: number;
  minute: number;
  pm: boolean;
}

function partsOf(d: Date, timeZone?: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const get = (type: string) => Number(fmt.formatToParts(d).find((p) => p.type === type)?.value ?? 0);
  // hour12:false can report midnight as 24 in some engines.
  const hour24 = get("hour") % 24;
  return {
    day: get("day"),
    month: MONTHS[get("month") - 1] ?? "",
    year: get("year"),
    hour: hour24 % 12 === 0 ? 12 : hour24 % 12,
    minute: get("minute"),
    pm: hour24 >= 12,
  };
}

/** "25 Sep 2026, 5:07 pm" */
export function formatDateTime(value: DateInput, timeZone?: string): string {
  const d = toDate(value);
  if (!d) return "—";
  const p = partsOf(d, timeZone);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${String(p.minute).padStart(2, "0")} ${p.pm ? "pm" : "am"}`;
}

/** "25 Sep 2026" */
export function formatDate(value: DateInput, timeZone?: string): string {
  const d = toDate(value);
  if (!d) return "—";
  const p = partsOf(d, timeZone);
  return `${p.day} ${p.month} ${p.year}`;
}

/** "25 Sep", for places where the year is obvious from context. */
export function formatDayMonth(value: DateInput, timeZone?: string): string {
  const d = toDate(value);
  if (!d) return "—";
  const p = partsOf(d, timeZone);
  return `${p.day} ${p.month}`;
}

/** Whole days between two instants, never negative. */
export function daysBetween(from: DateInput, to: DateInput = new Date()): number {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return 0;
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago", then a date. */
export function timeAgo(value: DateInput, now: DateInput = new Date()): string {
  const d = toDate(value);
  const n = toDate(now);
  if (!d || !n) return "—";
  const secs = Math.max(0, Math.round((n.getTime() - d.getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${plural(mins, "minute")} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${plural(days, "day")} ago`;
  return formatDate(d);
}

/**
 * A call's length in whole minutes, "12 min". Null when it has not ended. The
 * space does not break, so a narrow "When" column never strands "min".
 */
export function callMinutes(startedAt: DateInput, endedAt: DateInput): string | null {
  const a = toDate(startedAt);
  const b = toDate(endedAt);
  if (!a || !b) return null;
  const mins = Math.max(1, Math.round((b.getTime() - a.getTime()) / 60_000));
  return `${mins} min`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "10 am", "6:30 pm" from "HH:mm". */
function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h)) return hhmm;
  const hour = h % 12 === 0 ? 12 : h % 12;
  const suffix = h >= 12 && h < 24 ? "pm" : "am";
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

/** "Mon to Sat", "Mon, Wed and Fri", "every day". */
function describeDays(days: number[]): string {
  const sorted = Array.from(new Set(days.filter((d) => d >= 0 && d <= 6))).sort((a, b) => a - b);
  if (sorted.length === 0) return "no days";
  if (sorted.length === 7) return "every day";
  // Treat the week as Monday-first so Mon..Sat reads as one run.
  const mondayFirst = sorted.map((d) => (d + 6) % 7).sort((a, b) => a - b);
  const contiguous = mondayFirst.every((d, i) => i === 0 || d === mondayFirst[i - 1] + 1);
  const name = (mf: number) => WEEKDAYS[(mf + 1) % 7];
  if (contiguous && mondayFirst.length >= 3) {
    return `${name(mondayFirst[0])} to ${name(mondayFirst[mondayFirst.length - 1])}`;
  }
  const names = mondayFirst.map(name);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A job's call windows in words: "Mon to Sat, 10 am to 6 pm".
 *
 * No window means the agent accepts calls whenever the line is open, which is
 * what the worker does with an empty list — so it says that rather than
 * inventing hours.
 */
export function describeCallWindows(
  windows: Array<{ days: unknown; startTime: string; endTime: string }> | null | undefined
): string {
  if (!windows || windows.length === 0) return "any time the line is open";
  return windows
    .map((w) => {
      const days = Array.isArray(w.days) ? (w.days as number[]) : [];
      return `${describeDays(days)}, ${clock(w.startTime)} to ${clock(w.endTime)}`;
    })
    .join("; ");
}
