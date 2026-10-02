/**
 * Display formatting. Money arrives as rupees (plan prices) or paise (the
 * ledger); every figure is shown in Indian grouping, and every date in IST,
 * because that is where everyone reading this panel is.
 */
const TZ = "Asia/Kolkata";

export function inr(rupees: number): string {
  return `₹${Math.round(rupees).toLocaleString("en-IN")}`;
}

export function inrPaise(paise: number): string {
  const rupees = paise / 100;
  return Number.isInteger(rupees)
    ? `₹${rupees.toLocaleString("en-IN")}`
    : `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function num(n: number): string {
  return n.toLocaleString("en-IN");
}

function istParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Sep", or "14 Sep 2025" outside the current year. */
export function shortDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const [y, m, day] = istParts(new Date(d)).split("-");
  const sameYear = y === istParts(new Date()).slice(0, 4);
  return `${Number(day)} ${MONTHS[Number(m) - 1]}${sameYear ? "" : ` ${y}`}`;
}

/** "14 Sep 2026". */
export function longDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const [y, m, day] = istParts(new Date(d)).split("-");
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
}

function time(d: Date): string {
  return d
    .toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s?([ap])\.?m\.?/i, " $1m")
    .toLowerCase();
}

/** "Today, 2:10 pm", "Yesterday, 4:12 pm", or "26 Sep". */
export function when(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  const today = istParts(new Date());
  const yesterday = istParts(new Date(Date.now() - 86_400_000));
  const day = istParts(date);
  if (day === today) return `Today, ${time(date)}`;
  if (day === yesterday) return `Yesterday, ${time(date)}`;
  return shortDate(date);
}

/** "1h", "3h", "yesterday", "26 Sep": the activity feed's trailing age. */
export function ago(d: Date | string): string {
  const date = new Date(d);
  const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (istParts(date) === istParts(new Date())) return `${hours}h`;
  if (istParts(date) === istParts(new Date(Date.now() - 86_400_000))) return "yesterday";
  return shortDate(date);
}

/** The IST calendar day of a moment, as YYYY-MM-DD. */
export function istDay(d: Date = new Date()): string {
  return istParts(d);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}
