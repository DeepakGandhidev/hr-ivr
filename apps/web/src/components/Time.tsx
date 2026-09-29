"use client";

import { formatDate, formatDateTime, formatDayMonth, timeAgo } from "@/lib/format";

/**
 * A timestamp in the reader's own time zone.
 *
 * Rendered in the browser because the server's zone is not the reader's. The
 * server pass renders the same string in its own zone and the browser corrects
 * it on hydration, which is what suppressHydrationWarning is for — the mismatch
 * is expected and harmless.
 */
export default function Time({
  value,
  format = "datetime",
}: {
  value: string | Date | null | undefined;
  format?: "datetime" | "date" | "daymonth" | "ago";
}) {
  if (!value) return <span>—</span>;
  const iso = value instanceof Date ? value.toISOString() : value;
  const text =
    format === "date"
      ? formatDate(iso)
      : format === "daymonth"
        ? formatDayMonth(iso)
        : format === "ago"
          ? timeAgo(iso)
          : formatDateTime(iso);
  return (
    <time dateTime={iso} title={formatDateTime(iso)} suppressHydrationWarning>
      {text}
    </time>
  );
}
