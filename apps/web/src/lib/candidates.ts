/**
 * Candidate visibility and display, shared by every list, count and funnel.
 *
 * Archived and not-an-application candidates (Batch 7, PL50/PL51) are hidden
 * everywhere except their own Pipeline filters. Every query that lists or
 * counts candidates spreads ACTIVE_CANDIDATE into its where clause, so "hidden
 * everywhere" is one definition rather than a dozen remembered filters.
 */
export const ACTIVE_CANDIDATE = { archivedAt: null, notApplicationAt: null } as const;

/** The fallback-bucket routing: an application the router could not place. */
export const NO_JOB_ROUTING = "fallback";

/**
 * Display only (PL21): an ALL CAPS name reads as Title Case. Stored values stay
 * raw. Names with any lowercase letter are left exactly as given.
 */
export function displayName(name: string | null | undefined): string | null {
  if (!name) return null;
  if (name !== name.toUpperCase() || !/[A-Z]/.test(name)) return name;
  return name
    .toLowerCase()
    .replace(/(^|[\s\-'’.])([a-z\u00c0-\u024f])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** The screening that is current for a candidate: the newest one for their current job. */
export function currentScreening<T extends { jobId: string | null; createdAt: Date | string }>(
  screenings: T[],
  jobId: string
): T | null {
  return (
    screenings
      .filter((s) => s.jobId === jobId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null
  );
}
