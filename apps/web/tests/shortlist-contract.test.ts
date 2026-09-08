import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, not process.cwd(): the working directory differs
// between `npm test -w apps/web` and `vitest --root apps/web`, which silently
// turns these into "file not found" rather than a real assertion.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The shortlist page renders each member's score and verdict. When the endpoint
 * that feeds it stopped including `screenings`, the page read index [0] of an
 * undefined property and React replaced the entire route with "Application
 * error: a client-side exception has occurred" — the shortlist vanished the
 * moment it had its first member.
 *
 * A type cannot catch this: the page models the API response by hand, so both
 * sides compiled happily while disagreeing about the payload. Asserting on the
 * source is what the authz suite already does for the non-null approval_id
 * column, for the same reason — some invariants only exist at the seam.
 */

const routeSource = readFileSync(
  path.join(APP_ROOT, "src/app/api/[tenant]/shortlists/[id]/route.ts"),
  "utf8"
);

describe("shortlist detail endpoint", () => {
  it("includes the screenings the page renders", () => {
    expect(routeSource).toMatch(/screenings:\s*\{/);
  });

  it("includes the outreach emails the invite badge reads", () => {
    expect(routeSource).toMatch(/outreachEmails:\s*\{/);
  });

  it("still keeps the full email body out of the list payload", () => {
    // renderedBody is the entire message on every row; the page only draws a
    // badge from it.
    expect(routeSource).not.toContain("renderedBody: true");
  });
});

describe("shortlist page", () => {
  const pageSource = readFileSync(
    path.join(APP_ROOT, "src/app/[tenant]/jobs/[id]/shortlist/page.tsx"),
    "utf8"
  );

  it("never indexes screenings without guarding first", () => {
    // Belt and braces: even if an endpoint drops the field again, the page
    // should render without a score rather than take the whole route down.
    expect(pageSource).not.toMatch(/screenings\[0\]/);
    expect(pageSource).not.toMatch(/screenings\.length/);
  });
});
